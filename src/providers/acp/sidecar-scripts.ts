// The two tiny Node programs baked into every agent image. `link` is spawned
// by the agent as a stdio MCP server and forwards frames to `linkd`'s TCP port;
// `linkd` is exec'd by Anton and bridges that port to the exec channel, so MCP
// tool calls reach the host with no network endpoint and no token.

export const LINK_SCRIPT = `// stdin/stdout <-> TCP bridge for the agent's MCP client. Usage: node link.mjs <port>
import net from 'node:net';
const port = Number(process.argv[2] ?? 47900);
const socket = net.connect(port, '127.0.0.1');
socket.on('error', () => process.exit(1));
process.stdin.pipe(socket);
socket.pipe(process.stdout);
`;

export const LINKD_SCRIPT = `// Listens for the agent's MCP link on a TCP port and bridges it 1:1 to this
// process's stdio, the exec channel back to the host. One link per conversation.
// Usage: node linkd.mjs <port>
import net from 'node:net';
import readline from 'node:readline';
const port = Number(process.argv[2] ?? 47900);
net.createServer((socket) => {
  socket.setNoDelay(true);
  const fromAgent = readline.createInterface({ input: socket, crlfDelay: Infinity });
  fromAgent.on('line', (line) => process.stdout.write(line + '\\n'));
  const fromHost = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  fromHost.on('line', (line) => socket.write(line + '\\n'));
  fromHost.on('close', () => process.exit(0));
  socket.on('close', () => process.exit(0));
  socket.on('error', () => process.exit(1));
}).listen(port, '127.0.0.1', () => console.error('acp linkd listening on ' + port));
`;
