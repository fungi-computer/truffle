/*
 * Preloaded into the computerd 0.2.1 daemon that Fungi Local starts for an
 * attached folder. computerd binds 0.0.0.0 with no option to change it; its
 * RPC runs commands as this user, so it must never be reachable from the
 * network. Rebind every listener that asks for all interfaces to loopback.
 * Remove this once computerd accepts a listen host.
 */
"use strict";
const net = require("node:net");

// computerd calls listen(port, "0.0.0.0", callback).
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function loopbackListen(...args) {
  if (args[1] === "0.0.0.0") args[1] = "127.0.0.1";
  return listen.apply(this, args);
};
