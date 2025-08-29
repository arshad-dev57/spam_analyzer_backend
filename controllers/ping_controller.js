exports.ping = (req, res) => {
    console.log(`[PingController] Ping received at ${new Date().toISOString()}`);
    res.send('pong');
};