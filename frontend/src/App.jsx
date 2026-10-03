import { useState, useRef } from "react";

const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB high-water mark for backpressure
const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL || "ws://localhost:8080/ws/signal";

const ICE_SERVERS = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export default function App() {
  const [role, setRole] = useState(null); // 'sender' | 'receiver'
  const [roomCode, setRoomCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [status, setStatus] = useState("Ready to connect");
  const [statusState, setStatusState] = useState("disconnected"); // 'disconnected' | 'connecting' | 'connected'
  const [progress, setProgress] = useState(0);
  const [selectedFile, setSelectedFile] = useState(null);
  const [copied, setCopied] = useState(false);

  const ws = useRef(null);
  const pc = useRef(null);
  const dataChannel = useRef(null);
  const fileInputRef = useRef(null);

  // Receiver file assembly state
  const incomingFile = useRef({
    name: "",
    size: 0,
    type: "",
    receivedBytes: 0,
    buffers: [],
  });

  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  // 1. Initialize WebSocket Connection
  const connectSignaling = () => {
    return new Promise((resolve) => {
      setStatusState("connecting");
      setStatus("Connecting to signaling server...");
      ws.current = new WebSocket(SIGNALING_URL);

      ws.current.onopen = () => {
        setStatusState("connected");
        setStatus("Connected to server");
        resolve();
      };

      ws.current.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        handleSignalMessage(msg);
      };

      ws.current.onclose = () => {
        setStatusState("disconnected");
        setStatus("Disconnected from server");
      };
    });
  };

  // 2. WebRTC Signal Routing
  const handleSignalMessage = async (msg) => {
    switch (msg.type) {
      case "CREATED":
        setRoomCode(msg.roomCode);
        setStatus(`Room ${msg.roomCode} created. Waiting for peer to join...`);
        break;

      case "JOINED":
        setStatus("Joined room. Waiting for sender to connect...");
        break;

      case "PEER_JOINED":
        setStatus("Peer joined. Establishing direct P2P connection...");
        await initializeSenderHandshake();
        break;

      case "OFFER":
        await handleOffer(msg.payload, msg.roomCode);
        break;

      case "ANSWER":
        await pc.current.setRemoteDescription(
          new RTCSessionDescription(msg.payload)
        );
        setStatusState("connected");
        setStatus("Connected to peer! Ready to transfer.");
        break;

      case "ICE_CANDIDATE":
        if (msg.payload && pc.current) {
          await pc.current.addIceCandidate(new RTCIceCandidate(msg.payload));
        }
        break;

      case "PEER_LEFT":
        setStatusState("disconnected");
        setStatus("Remote peer disconnected.");
        resetState();
        break;

      case "ERROR":
        alert(msg.payload);
        setStatusState("disconnected");
        setStatus(`Error: ${msg.payload}`);
        break;
    }
  };

  // 3. Sender Setup: Create PeerConnection, DataChannel, and Offer
  const initializeSenderHandshake = async () => {
    pc.current = new RTCPeerConnection(ICE_SERVERS);

    pc.current.onicecandidate = (event) => {
      if (event.candidate) {
        ws.current.send(
          JSON.stringify({
            type: "ICE_CANDIDATE",
            roomCode,
            payload: event.candidate,
          })
        );
      }
    };

    dataChannel.current = pc.current.createDataChannel("fileTransfer", {
      ordered: true,
    });
    dataChannel.current.binaryType = "arraybuffer";

    dataChannel.current.onopen = () => {
      setStatusState("connected");
      setStatus("Direct P2P Link Established! Ready to transfer.");
    };

    const offer = await pc.current.createOffer();
    await pc.current.setLocalDescription(offer);

    ws.current.send(
      JSON.stringify({
        type: "OFFER",
        roomCode,
        payload: offer,
      })
    );
  };

  // 4. Receiver Setup: Ingest Offer, Create Answer, Listen for Channel
  const handleOffer = async (offerPayload, code) => {
    pc.current = new RTCPeerConnection(ICE_SERVERS);

    pc.current.onicecandidate = (event) => {
      if (event.candidate) {
        ws.current.send(
          JSON.stringify({
            type: "ICE_CANDIDATE",
            roomCode: code,
            payload: event.candidate,
          })
        );
      }
    };

    pc.current.ondatachannel = (event) => {
      dataChannel.current = event.channel;
      dataChannel.current.binaryType = "arraybuffer";
      dataChannel.current.onmessage = handleIncomingData;
      dataChannel.current.onopen = () => {
        setStatusState("connected");
        setStatus("Connected to sender! Ready to receive file.");
      };
    };

    await pc.current.setRemoteDescription(
      new RTCSessionDescription(offerPayload)
    );
    const answer = await pc.current.createAnswer();
    await pc.current.setLocalDescription(answer);

    ws.current.send(
      JSON.stringify({
        type: "ANSWER",
        roomCode: code,
        payload: answer,
      })
    );
  };

  // 5. Sender: Chunk Slicing and Backpressure Control
  const startSendingFile = async () => {
    if (
      !selectedFile ||
      !dataChannel.current ||
      dataChannel.current.readyState !== "open"
    ) {
      alert("Connection is not ready or no file is selected.");
      return;
    }

    const channel = dataChannel.current;
    channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;

    const metadata = {
      type: "METADATA",
      name: selectedFile.name,
      size: selectedFile.size,
      mimeType: selectedFile.type,
    };
    channel.send(JSON.stringify(metadata));

    let offset = 0;
    setStatus(`Sending ${selectedFile.name}...`);

    const sendNextChunk = () => {
      while (offset < selectedFile.size) {
        if (channel.bufferedAmount > BUFFER_THRESHOLD) {
          channel.onbufferedamountlow = () => {
            channel.onbufferedamountlow = null;
            sendNextChunk();
          };
          return;
        }

        const slice = selectedFile.slice(offset, offset + CHUNK_SIZE);
        const reader = new FileReader();

        reader.onload = (e) => {
          channel.send(e.target.result);
          offset += e.target.result.byteLength;
          setProgress(Math.round((offset / selectedFile.size) * 100));

          if (offset >= selectedFile.size) {
            setStatus("File transfer complete!");
          } else {
            sendNextChunk();
          }
        };

        reader.readAsArrayBuffer(slice);
        return;
      }
    };

    sendNextChunk();
  };

  // 6. Receiver: Buffer Ingestion & Assembly
  const handleIncomingData = (event) => {
    if (typeof event.data === "string") {
      const msg = JSON.parse(event.data);
      if (msg.type === "METADATA") {
        incomingFile.current = {
          name: msg.name,
          size: msg.size,
          type: msg.mimeType,
          receivedBytes: 0,
          buffers: [],
        };
        setStatus(`Receiving: ${msg.name} (${formatBytes(msg.size)})`);
      }
      return;
    }

    const buffer = event.data;
    incomingFile.current.buffers.push(buffer);
    incomingFile.current.receivedBytes += buffer.byteLength;

    const percent = Math.round(
      (incomingFile.current.receivedBytes / incomingFile.current.size) * 100
    );
    setProgress(percent);

    if (incomingFile.current.receivedBytes >= incomingFile.current.size) {
      assembleAndDownloadFile();
    }
  };

  const assembleAndDownloadFile = () => {
    setStatus("Assembling file...");
    const blob = new Blob(incomingFile.current.buffers, {
      type: incomingFile.current.type,
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = incomingFile.current.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus(`Downloaded: ${incomingFile.current.name}`);
  };

  const resetState = () => {
    if (pc.current) pc.current.close();
    if (ws.current) ws.current.close();
    setRole(null);
    setRoomCode("");
    setInputCode("");
    setSelectedFile(null);
    setProgress(0);
    setStatusState("disconnected");
    setStatus("Ready to connect");
  };

  const copyRoomCode = () => {
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Action Triggers
  const initSender = async () => {
    setRole("sender");
    await connectSignaling();
    ws.current.send(JSON.stringify({ type: "CREATE" }));
  };

  const initReceiver = async () => {
    if (!inputCode.trim()) return alert("Please enter a 6-character room code");
    const code = inputCode.trim().toUpperCase();
    setRole("receiver");
    setRoomCode(code);
    await connectSignaling();
    ws.current.send(
      JSON.stringify({
        type: "JOIN",
        roomCode: code,
      })
    );
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="logo-badge">
          <span className="logo-dot"></span>
          <span>Peer-to-Peer Transfer</span>
        </div>
        <h1 className="app-title">PeerLink</h1>
        <p className="app-subtitle">
          Direct, secure file sharing straight between browsers
        </p>
      </header>

      {/* Main Card */}
      <main className="card">
        {/* Status Indicator Bar */}
        <div className="status-bar">
          <div>
            <span className={`status-indicator ${statusState}`}></span>
            <span className="status-text">{status}</span>
          </div>
          <span className="status-badge">WebRTC P2P</span>
        </div>

        {/* View 1: Choose Send or Receive */}
        {!role ? (
          <div className="role-grid">
            {/* Send File Card */}
            <div className="role-box">
              <div className="role-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <h2 className="role-title">Send a File</h2>
              <p className="role-desc">
                Create a room code and transfer files directly to another device.
              </p>
              <button className="btn btn-green" onClick={initSender}>
                Create Room
              </button>
            </div>

            {/* Receive File Card */}
            <div className="role-box">
              <div className="role-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </div>
              <h2 className="role-title">Receive a File</h2>
              <p className="role-desc">
                Enter the 6-character room code provided by the sender.
              </p>
              <div className="receive-form">
                <input
                  type="text"
                  maxLength="6"
                  placeholder="CODE"
                  className="code-input"
                  value={inputCode}
                  onChange={(e) => setInputCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === "Enter" && initReceiver()}
                />
                <button className="btn btn-outline" onClick={initReceiver}>
                  Join
                </button>
              </div>
            </div>
          </div>
        ) : role === "sender" ? (
          /* View 2: Sender View */
          <div>
            <div className="dashboard-top">
              <span className="dashboard-title">Send File</span>
              <button className="btn-text" onClick={resetState}>
                ✕ Leave Room
              </button>
            </div>

            {/* Room Code Box */}
            <div className="code-display-card">
              <div className="code-display-label">Share this Room Code with the recipient:</div>
              <div className="code-display-wrapper">
                <span className="code-display-value">
                  {roomCode || "Generating..."}
                </span>
                {roomCode && (
                  <button className="btn-copy-code" onClick={copyRoomCode}>
                    {copied ? "✓ Copied" : "Copy"}
                  </button>
                )}
              </div>
            </div>

            {/* File Selector */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={(e) => setSelectedFile(e.target.files[0])}
              style={{ display: "none" }}
            />

            {!selectedFile ? (
              <div
                className="file-dropzone"
                onClick={() => fileInputRef.current?.click()}
              >
                <svg className="file-dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <div className="file-dropzone-title">Click to select a file</div>
                <div className="file-dropzone-sub">Any file format supported</div>
              </div>
            ) : (
              <div className="selected-file-row">
                <div className="selected-file-left">
                  <span style={{ fontSize: "1.2rem" }}>📄</span>
                  <div>
                    <div className="selected-file-name">{selectedFile.name}</div>
                    <div className="selected-file-size">{formatBytes(selectedFile.size)}</div>
                  </div>
                </div>
                <button
                  className="btn-text"
                  onClick={() => setSelectedFile(null)}
                >
                  Change
                </button>
              </div>
            )}

            <button
              className="btn btn-green"
              onClick={startSendingFile}
              disabled={!selectedFile}
            >
              Start File Transfer
            </button>
          </div>
        ) : (
          /* View 3: Receiver View */
          <div>
            <div className="dashboard-top">
              <span className="dashboard-title">Receive File</span>
              <button className="btn-text" onClick={resetState}>
                ✕ Leave Room
              </button>
            </div>

            <div className="code-display-card">
              <div className="code-display-label">Connected to Room</div>
              <div className="code-display-wrapper">
                <span className="code-display-value">{roomCode}</span>
              </div>
            </div>

            <div style={{ textAlign: "center", padding: "20px 0", color: "var(--color-text-sub)", fontSize: "0.9rem" }}>
              Waiting for the sender to transmit the file...
            </div>
          </div>
        )}

        {/* Transfer Progress */}
        {progress > 0 && (
          <div className="progress-container">
            <div className="progress-labels">
              <span>Transferring...</span>
              <span className="progress-percentage">{progress}%</span>
            </div>
            <div className="progress-bar-bg">
              <div
                className="progress-bar-fill"
                style={{ width: `${progress}%` }}
              ></div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="app-footer">
        <div className="footer-item">
          <span>🔒 Direct P2P Encryption</span>
        </div>
        <span>•</span>
        <div className="footer-item">
          <span>⚡ No Server Storage</span>
        </div>
      </footer>
    </div>
  );
}
