package com.peerlink.handler;

import com.peerlink.model.SignalMessage;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.security.SecureRandom;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class SignalSocketHandler extends TextWebSocketHandler {

    public final ObjectMapper objectMapper = new ObjectMapper();
    public final SecureRandom random = new SecureRandom();

    // roomCode -> Pair of [Initiator, Guest]
    private final Map<String, WebSocketSession[]> rooms = new ConcurrentHashMap<>();
    // sessionId -> roomCode
    private final Map<String,String> sessionRoomMap= new ConcurrentHashMap<>();

    @Override
    public void afterConnectionEstablished(WebSocketSession session){
        // Wrap session with a decorator to handle concurrent socket sends safely
        WebSocketSession safeSession = new ConcurrentWebSocketSessionDecorator(session,5000,1024*1024);
        session.getAttributes().put("safeSession",safeSession);
    }

    @Override
    protected  void handleTextMessage(WebSocketSession rawSession, TextMessage textMessage) throws Exception{
        WebSocketSession session = (WebSocketSession) rawSession.getAttributes().get("safeSession");
        SignalMessage message = objectMapper.readValue(textMessage.getPayload(),SignalMessage.class);

        switch(message.getType()){
            case "CREATE" ->handleCreateRoom(session);
            case "JOIN" ->handleJoinRoom(session,message.getRoomCode());
            case "OFFER", "ANSWER", "ICE_CANDIDATE" ->relaySignal(session,message);
            default -> sendDirect(session, new SignalMessage("ERROR",null,"Unknown message Type"));
        }
    }

    private void handleCreateRoom(WebSocketSession session) throws IOException {
        String roomCode = generateRoomCode();
        rooms.put(roomCode,new WebSocketSession[]{session,null});
        sessionRoomMap.put(session.getId(),roomCode);

        sendDirect(session, new SignalMessage("CREATED", roomCode, "Room created successfully"));
    }

    private void handleJoinRoom(WebSocketSession session,String roomCode) throws IOException{
        WebSocketSession[] pair = rooms.get(roomCode);

        if (pair == null) {
            sendDirect(session, new SignalMessage("ERROR", roomCode, "Room does not exist"));
            return;
        }
        if (pair[1] != null) {
            sendDirect(session, new SignalMessage("ERROR", roomCode, "Room is full"));
            return;
        }

        //Register guest
        pair[1]=session;
        sessionRoomMap.put(session.getId(),roomCode);
        sendDirect(session, new SignalMessage("JOINED", roomCode, "Joined successfully"));
        // Notify initiator that the peer is present so it can produce an SDP offer
        sendDirect(pair[0], new SignalMessage("PEER_JOINED", roomCode, null));
    }

    private void relaySignal(WebSocketSession sender, SignalMessage message) throws IOException{
        String roomCode = sessionRoomMap.get(sender.getId());
        if(roomCode == null) return;

        WebSocketSession[] pair=rooms.get(roomCode);
        if(pair==null) return;

        // Route payload to the opposite peer
        WebSocketSession recipient = (pair[0] != null && pair[0].getId().equals(sender.getId())) ? pair[1] : pair[0];
        if (recipient != null && recipient.isOpen()) {
            sendDirect(recipient, message);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        String roomCode=sessionRoomMap.remove(session.getId());
        if (roomCode==null) return;

        WebSocketSession[] pair= rooms.remove(roomCode);
        if(pair != null){
            WebSocketSession peer=pair[0].getId().equals(session.getId())?pair[1]:pair[0];

            if(peer != null && peer.isOpen()){
                sessionRoomMap.remove(peer.getId());
                sendDirect(peer, new SignalMessage("PEER_LEFT", roomCode, "The remote peer disconnected"));
            }
        }
    }

    private void sendDirect(WebSocketSession session,SignalMessage msg) throws IOException {
        if(session!=null && session.isOpen()){
            session.sendMessage(new TextMessage(objectMapper.writeValueAsString(msg)));
        }
    }

    private String generateRoomCode() {
        String chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        StringBuilder sb = new StringBuilder(6);
        for (int i = 0; i < 6; i++) {
            sb.append(chars.charAt(random.nextInt(chars.length())));
        }
        return sb.toString();
    }

}
