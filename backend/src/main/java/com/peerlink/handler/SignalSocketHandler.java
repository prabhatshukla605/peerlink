package com.peerlink.handler;

import com.peerlink.model.SignalMessage;
import org.springframework.stereotype.Component;
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

        if(pair==null){
            sendDirect("ERROR",roomCode, "Room does not exists");
            return;
        }
        if(pair[1]!=null){
            sendDirect("ERROR",roomCode, "Room is full");
            return;
        }

        //Register guest
        pair[1]=session;
        sessionRoomMap.put(session.getId(),roomCode);
        sendDirect(session, new SignalMessage("JOINED", roomCode, "Joined successfully"));
        // Notify initiator that the peer is present so it can produce an SDP offer
        sendDirect(pair[0], new SignalMessage("PEER_JOINED", roomCode, null));
    }

}
