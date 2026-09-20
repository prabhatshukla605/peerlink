package com.peerlink.config;

import com.peerlink.handler.SignalSocketHandler;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final SignalSocketHandler signalSocketHandler;

    public WebSocketConfig(SignalSocketHandler signalSocketHandler){
        this.signalSocketHandler=signalSocketHandler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry){
        registry.addHandler(signalSocketHandler,"/ws/signal")
                .setAllowedOrigins("*");
    }

}
