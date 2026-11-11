// Servidor de salas de Payasitos Estelares.
// No juega ni guarda nada: solo junta a los jugadores de una misma sala y les pasa los mensajes.
// Las reglas siguen corriendo en el juego del anfitrión. Nadie ve la IP de nadie.
//
// Protocolo (WebSocket):
//   Texto (JSON), control:
//     -> {"op":"crear","v":1,"codigo":"ABC123"?} <- {"op":"sala","codigo":"ABC123","id":1}
//        (si se pide un código y está libre, se usa: así al cargar una partida vale la invitación de antes)
//     -> {"op":"cerrar"}  (el anfitrión se va: la sala se cierra al instante y se echa a todos)
//     -> {"op":"unirse","codigo":"ABC123"} <- {"op":"dentro","id":N}   (y al anfitrión: {"op":"llega","id":N})
//     -> {"op":"echar","id":N}  (solo el anfitrión)
//                                          <- {"op":"sale","id":N}
//                                          <- {"op":"error","motivo":"..."} y se cierra
//   Binario, datos del juego:
//     -> [destino int32 LE][datos]   destino 0 = todos, >0 = uno, <0 = todos menos -destino
//     <- [origen int32 LE][datos]

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PUERTO = Number(process.env.PORT) || 8080;
const MAX_JUGADORES = 4;
const MAX_MENSAJE = 512 * 1024;          // un estado de partida completo cabe de sobra
const MAX_MENSAJES_SEG = 120;            // por conexión
const VIDA_SALA_MS = 12 * 60 * 60 * 1000;
const INTENTOS_UNIRSE = 12;              // por IP y minuto: adivinar códigos no sale a cuenta
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";  // sin letras ambiguas
const LARGO_CODIGO = 6;
const LATIDO_MS = 10_000;                // cada cuánto se comprueba que cada conexión sigue viva
const MAX_CONEXIONES_IP = 20;            // una casa con varios jugadores cabe de sobra
const MAX_SALAS_IP_MIN = 5;              // crear salas sin parar no sale a cuenta
const MAX_SALAS = 2000;

const salas = new Map();      // codigo -> {codigo, anfitrion, jugadores: Map(id -> ws), creada}
const intentos = new Map();   // ip -> {n, desde}
const creadas = new Map();    // ip -> {n, desde}
const conexiones = new Map(); // ip -> número de conexiones abiertas

function nuevoCodigo() {
  for (;;) {
    let c = "";
    const bytes = crypto.randomBytes(LARGO_CODIGO);
    for (let i = 0; i < LARGO_CODIGO; i++) c += ALFABETO[bytes[i] % ALFABETO.length];
    if (!salas.has(c)) return c;
  }
}

function nuevoId(sala) {
  for (;;) {
    const id = 2 + crypto.randomInt(0x7ffffff0);
    if (!sala.jugadores.has(id)) return id;
  }
}

function enviar(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function echar(ws, motivo) {
  enviar(ws, { op: "error", motivo });
  ws.close(4000, motivo);
}

// IP real de quien se conecta. Render va detrás de Cloudflare, que pone cf-connecting-ip
// (no se puede falsificar). Si no está, la ÚLTIMA de x-forwarded-for (la añade el proxy); las
// de delante las puede inventar quien se conecta.
function ipDe(req) {
  for (const h of ["cf-connecting-ip", "true-client-ip"]) {
    const v = req.headers[h];
    if (v) return String(v).trim();
  }
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) {
    const partes = String(fwd).split(",").map((x) => x.trim()).filter(Boolean);
    if (partes.length) return partes[partes.length - 1];
  }
  return (req.socket.remoteAddress || "").trim();
}

function contar(mapa, ip, maximo) {
  const ahora = Date.now();
  const r = mapa.get(ip) || { n: 0, desde: ahora };
  if (ahora - r.desde > 60_000) { r.n = 0; r.desde = ahora; }
  r.n++;
  mapa.set(ip, r);
  return r.n <= maximo;
}

function puedeIntentar(ip) {
  return contar(intentos, ip, INTENTOS_UNIRSE);
}

function codigoValido(c) {
  if (typeof c !== "string" || c.length !== LARGO_CODIGO) return false;
  for (const ch of c) if (!ALFABETO.includes(ch)) return false;
  return true;
}

function cerrarSala(sala, motivo) {
  if (!salas.has(sala.codigo)) return;
  salas.delete(sala.codigo);
  for (const [id, ws] of sala.jugadores) {
    if (id !== 1) echar(ws, motivo);
  }
}

function salir(ws) {
  if (!ws.contado) {
    ws.contado = true;
    const n = (conexiones.get(ws.ip) || 1) - 1;
    if (n <= 0) conexiones.delete(ws.ip); else conexiones.set(ws.ip, n);
  }
  const sala = ws.sala;
  if (!sala) return;
  ws.sala = null;
  if (ws.id === 1) {
    cerrarSala(sala, "anfitrion_salio");
    return;
  }
  sala.jugadores.delete(ws.id);
  const anfitrion = sala.jugadores.get(1);
  if (anfitrion) enviar(anfitrion, { op: "sale", id: ws.id });
  for (const [id, otro] of sala.jugadores) {
    if (id !== 1) enviar(otro, { op: "sale", id: ws.id });
  }
}

// Respuesta HTTP: la usa el juego para despertar al servidor y comprobar que está vivo.
const servidor = http.createServer((req, res) => {
  // /quien: devuelve la IP que el servidor cree que tienes (solo a ti), para comprobar los límites.
  if (req.url === "/quien") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(ipDe(req) + "\n");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" });
  res.end("payasitos-salas ok " + salas.size + "\n");
});

const wss = new WebSocketServer({ server: servidor, maxPayload: MAX_MENSAJE });

wss.on("connection", (ws, req) => {
  ws.ip = ipDe(req);
  ws.contado = false;
  const abiertas = (conexiones.get(ws.ip) || 0) + 1;
  conexiones.set(ws.ip, abiertas);
  if (abiertas > MAX_CONEXIONES_IP) {
    ws.contado = true;
    conexiones.set(ws.ip, abiertas - 1);
    return echar(ws, "demasiadas_conexiones");
  }
  ws.sala = null;
  ws.id = 0;
  ws.vivo = true;
  ws.cuenta = 0;
  ws.segundo = Date.now();
  ws.on("pong", () => { ws.vivo = true; });

  ws.on("message", (datos, binario) => {
    const ahora = Date.now();
    if (ahora - ws.segundo > 1000) { ws.cuenta = 0; ws.segundo = ahora; }
    if (++ws.cuenta > MAX_MENSAJES_SEG) return echar(ws, "demasiados_mensajes");

    if (binario) {
      const sala = ws.sala;
      if (!sala || datos.length < 4) return;
      const destino = datos.readInt32LE(0);
      const salida = Buffer.from(datos);
      salida.writeInt32LE(ws.id, 0);
      if (destino > 0) {
        const otro = sala.jugadores.get(destino);
        if (otro && otro.readyState === otro.OPEN) otro.send(salida, { binary: true });
      } else {
        for (const [id, otro] of sala.jugadores) {
          if (id === ws.id || id === -destino) continue;
          if (otro.readyState === otro.OPEN) otro.send(salida, { binary: true });
        }
      }
      return;
    }

    let m;
    try { m = JSON.parse(datos.toString()); } catch { return echar(ws, "mensaje_raro"); }
    if (m.op === "crear") {
      if (ws.sala) return;
      if (salas.size >= MAX_SALAS) return echar(ws, "servidor_lleno");
      if (!contar(creadas, ws.ip, MAX_SALAS_IP_MIN)) return echar(ws, "espera_un_minuto");
      const pedido = String(m.codigo || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const codigo = codigoValido(pedido) && !salas.has(pedido) ? pedido : nuevoCodigo();
      const sala = { codigo, jugadores: new Map(), creada: Date.now() };
      ws.id = 1;
      ws.sala = sala;
      sala.jugadores.set(1, ws);
      salas.set(sala.codigo, sala);
      enviar(ws, { op: "sala", codigo: sala.codigo, id: 1 });
    } else if (m.op === "unirse") {
      if (ws.sala) return;
      if (!puedeIntentar(ws.ip)) return echar(ws, "espera_un_minuto");
      const codigo = String(m.codigo || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const sala = salas.get(codigo);
      if (!sala) return echar(ws, "no_existe");
      if (sala.jugadores.size >= MAX_JUGADORES) return echar(ws, "llena");
      ws.id = nuevoId(sala);
      ws.sala = sala;
      sala.jugadores.set(ws.id, ws);
      enviar(ws, { op: "dentro", id: ws.id });
      enviar(sala.jugadores.get(1), { op: "llega", id: ws.id });
    } else if (m.op === "cerrar") {
      // El anfitrión se despide: sala cerrada ya, sin esperar a que se corte la conexión.
      if (ws.sala && ws.id === 1) {
        const sala = ws.sala;
        ws.sala = null;
        cerrarSala(sala, "anfitrion_salio");
      }
      ws.close(1000, "adios");
    } else if (m.op === "echar") {
      if (!ws.sala || ws.id !== 1) return;
      const otro = ws.sala.jugadores.get(Number(m.id));
      if (otro && otro !== ws) echar(otro, "expulsado");
    }
  });

  ws.on("close", () => salir(ws));
  ws.on("error", () => salir(ws));
});

// Latido: corta conexiones muertas y salas viejas.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.vivo) { ws.terminate(); continue; }
    ws.vivo = false;
    ws.ping();
  }
  const ahora = Date.now();
  for (const sala of salas.values()) {
    if (ahora - sala.creada > VIDA_SALA_MS) cerrarSala(sala, "sala_caducada");
  }
  for (const mapa of [intentos, creadas]) {
    for (const [ip, r] of mapa) {
      if (ahora - r.desde > 120_000) mapa.delete(ip);
    }
  }
}, LATIDO_MS);

servidor.listen(PUERTO, () => {
  console.log("Servidor de salas escuchando en el puerto " + PUERTO);
});
