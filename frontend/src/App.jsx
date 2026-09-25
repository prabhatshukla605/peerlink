import { useState, useRef } from "react";

const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB high-water mark for backpressure

const ICE_SERVERS = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export default function App() {
  const [role, setRole] = useState(null); // 'sender' | 'receiver'
  const [roomCode, setRoomCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [status, setStatus] = useState("Disconnected");
  const [progress, setProgress] = useState(0);
  const [selectedFile, setSelectedFile] = useState(null);

  const ws = useRef(null);
  const pc = useRef(null);
  const dataChannel = useRef(null);

  // Receiver file assembly state
  const incomingFile = useRef({
    name: "",
    size: 0,
    type: "",
    receivedBytes: 0,
    buffers: [],
  });

  // 1. Initialize WebSocket Connection
  const connectSignaling = () => {
    return new Promise((resolve) => {
      ws.current = new WebSocket("ws://localhost:8080/ws/signal");

      ws.current.onopen = () => {
        setStatus("Connected to Signaling Server");
        resolve();
      };

      ws.current.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        handleSignalMessage(msg);
      };

      ws.current.onclose = () => setStatus("Signaling Disconnected");
    });
  };

  // 2. WebRTC Signal Routing
  const handleSignalMessage = async (msg) => {
    switch (msg.type) {
      case "CREATED":
        setRoomCode(msg.roomCode);
        setStatus(`Room Created: ${msg.roomCode}. Waiting for peer to join...`);
        break;

      case "JOINED":
        setStatus("Joined Room. Waiting for sender to initiate link...");
        break;

      case "PEER_JOINED":
        setStatus("Peer joined. Initializing P2P connection...");
        await initializeSenderHandshake();
        break;

      case "OFFER":
        await handleOffer(msg.payload, msg.roomCode);
        break;

      case "ANSWER":
        await pc.current.setRemoteDescription(
          new RTCSessionDescription(msg.payload),
        );
        setStatus("Direct P2P Link Established!");
        break;

      case "ICE_CANDIDATE":
        if (msg.payload && pc.current) {
          await pc.current.addIceCandidate(new RTCIceCandidate(msg.payload));
        }
        break;

      case "PEER_LEFT":
        setStatus("Remote peer disconnected.");
        resetState();
        break;

      case "ERROR":
        alert(msg.payload);
        break;
    }
  };

  // 3. Sender Setup: Create PeerConnection, DataChannel, and Offer
  const initializeSenderHandshake = async () => {
    pc.current = new RTCPeerConnection(ICE_SERVERS);

    // Stream ICE candidates through signaling server
    pc.current.onicecandidate = (event) => {
      if (event.candidate) {
        ws.current.send(
          JSON.stringify({
            type: "ICE_CANDIDATE",
            roomCode,
            payload: event.candidate,
          }),
        );
      }
    };

    // Set up high-throughput binary DataChannel
    dataChannel.current = pc.current.createDataChannel("fileTransfer", {
      ordered: true,
    });
    dataChannel.current.binaryType = "arraybuffer";

    dataChannel.current.onopen = () => {
      setStatus("Direct P2P Link Established! Ready to transfer.");
    };

    const offer = await pc.current.createOffer();
    await pc.current.setLocalDescription(offer);

    ws.current.send(
      JSON.stringify({
        type: "OFFER",
        roomCode,
        payload: offer,
      }),
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
          }),
        );
      }
    };

    pc.current.ondatachannel = (event) => {
      dataChannel.current = event.channel;
      dataChannel.current.binaryType = "arraybuffer";
      dataChannel.current.onmessage = handleIncomingData;
      dataChannel.current.onopen = () =>
        setStatus("Direct P2P Link Established!");
    };

    await pc.current.setRemoteDescription(
      new RTCSessionDescription(offerPayload),
    );
    const answer = await pc.current.createAnswer();
    await pc.current.setLocalDescription(answer);

    ws.current.send(
      JSON.stringify({
        type: "ANSWER",
        roomCode: code,
        payload: answer,
      }),
    );
  };

  // 5. Sender: Chunk Slicing and Backpressure Control
  const startSendingFile = async () => {
    if (
      !selectedFile ||
      !dataChannel.current ||
      dataChannel.current.readyState !== "open"
    ) {
      alert("Data channel is not open or no file selected.");
      return;
    }

    const channel = dataChannel.current;
    channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;

    // Send metadata header first
    const metadata = {
      type: "METADATA",
      name: selectedFile.name,
      size: selectedFile.size,
      mimeType: selectedFile.type,
    };
    channel.send(JSON.stringify(metadata));

    let offset = 0;
    setStatus("Transferring file...");

    const sendNextChunk = () => {
      while (offset < selectedFile.size) {
        // Backpressure check: pause reading if internal browser buffer is full
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
        setStatus(
          `Receiving: ${msg.name} (${(msg.size / (1024 * 1024)).toFixed(2)} MB)`,
        );
      }
      return;
    }

    // Binary chunk packet
    const buffer = event.data;
    incomingFile.current.buffers.push(buffer);
    incomingFile.current.receivedBytes += buffer.byteLength;

    const percent = Math.round(
      (incomingFile.current.receivedBytes / incomingFile.current.size) * 100,
    );
    setProgress(percent);

    if (incomingFile.current.receivedBytes >= incomingFile.current.size) {
      assembleAndDownloadFile();
    }
  };

  const assembleAndDownloadFile = () => {
    setStatus("Reassembling file...");
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

    setStatus(`Download complete: ${incomingFile.current.name}`);
  };

  const resetState = () => {
    if (pc.current) pc.current.close();
    setProgress(0);
  };

  // Actions
  const initSender = async () => {
    setRole("sender");
    await connectSignaling();
    ws.current.send(JSON.stringify({ type: "CREATE" }));
  };

  const initReceiver = async () => {
    if (!inputCode.trim()) return alert("Enter invite code");
    setRole("receiver");
    setRoomCode(inputCode.trim().toUpperCase());
    await connectSignaling();
    ws.current.send(
      JSON.stringify({
        type: "JOIN",
        roomCode: inputCode.trim().toUpperCase(),
      }),
    );
  };

  return (
    <div
      style={{
        maxWidth: "600px",
        margin: "40px auto",
        fontFamily: "sans-serif",
        padding: "20px",
        border: "1px solid #ddd",
        borderRadius: "8px",
      }}
    >
      <h2>PeerLink — P2P File Sharing</h2>
      <p>
        <strong>Status:</strong> {status}
      </p>

      {!role ? (
        <div style={{ display: "flex", gap: "20px", marginTop: "20px" }}>
          <button
            style={{ padding: "10px 20px", flex: 1 }}
            onClick={initSender}
          >
            Send a File (Create Room)
          </button>
          <div style={{ flex: 1 }}>
            <input
              type="text"
              placeholder="Enter 6-char code"
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value)}
              style={{ padding: "10px", width: "60%", marginRight: "8px" }}
            />
            <button style={{ padding: "10px" }} onClick={initReceiver}>
              Receive
            </button>
          </div>
        </div>
      ) : role === "sender" ? (
        <div>
          <h3>Sender Dashboard</h3>
          <p>
            Share this code with the recipient:{" "}
            <strong>{roomCode || "Generating..."}</strong>
          </p>
          <input
            type="file"
            onChange={(e) => setSelectedFile(e.target.files[0])}
            style={{ margin: "15px 0" }}
          />
          <br />
          <button
            onClick={startSendingFile}
            disabled={!selectedFile}
            style={{
              padding: "10px 20px",
              background: "#007bff",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
            }}
          >
            Start Direct Transfer
          </button>
        </div>
      ) : (
        <div>
          <h3>Receiver Dashboard</h3>
          <p>
            Connected to Room: <strong>{roomCode}</strong>
          </p>
        </div>
      )}

      {progress > 0 && (
        <div style={{ marginTop: "25px" }}>
          <label>Transfer Progress: {progress}%</label>
          <div
            style={{
              width: "100%",
              height: "20px",
              background: "#eee",
              borderRadius: "10px",
              overflow: "hidden",
              marginTop: "5px",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background: "#28a745",
                transition: "width 0.2s",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
