// Background worker to maintain connection on mobile
let heartbeatInterval = null;
let connectionStatus = { isConnected: false, lastHeartbeat: Date.now() };

self.addEventListener('message', (e) => {
    const { type, data } = e.data;

    if (type === 'START_HEARTBEAT') {
        startHeartbeat(data.interval);
    } else if (type === 'STOP_HEARTBEAT') {
        stopHeartbeat();
    } else if (type === 'HEARTBEAT_ACK') {
        connectionStatus.lastHeartbeat = Date.now();
        connectionStatus.isConnected = true;
    }
});

function startHeartbeat(interval) {
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    heartbeatInterval = setInterval(() => {
        self.postMessage({ type: 'SEND_HEARTBEAT', timestamp: Date.now() });
    }, interval);
}

function stopHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
}
