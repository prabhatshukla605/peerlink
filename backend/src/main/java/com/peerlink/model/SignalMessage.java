package com.peerlink.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class SignalMessage {
    private String type;      // CREATE, JOIN, OFFER, ANSWER, ICE_CANDIDATE, PEER_JOINED, PEER_LEFT, ERROR
    private String roomCode;  // 6-character room identifier
    private Object payload;   // SDP object, ICE candidate, or status message

    public SignalMessage() {}

    public SignalMessage(String type, String roomCode, Object payload) {
        this.type = type;
        this.roomCode = roomCode;
        this.payload = payload;
    }

    public String getType() { return type; }
    public void setType(String type) { this.type = type; }

    public String getRoomCode() { return roomCode; }
    public void setRoomCode(String roomCode) { this.roomCode = roomCode; }

    public Object getPayload() { return payload; }
    public void setPayload(Object payload) { this.payload = payload; }
}