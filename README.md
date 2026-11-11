# Servidor de salas de Payasitos Estelares

Junta a los jugadores de una misma sala y les pasa los mensajes. No juega ni guarda nada: las
reglas corren en el juego del anfitrión. Todos se conectan hacia fuera, así que nadie abre
puertos y nadie ve la IP de nadie.

## Probar en tu PC

```
npm install
npm start
```

Y lanza el juego con la variable `PAYASITOS_SALAS=ws://localhost:8080`.

## Publicarlo en Render (gratis)

1. Sube a un repositorio de GitHub estos archivos: `server.js`, `package.json`,
   `package-lock.json`, `.gitignore` y este `README.md` (la carpeta `node_modules` NO).
2. En Render: **New → Web Service**, elige el repositorio y rellena:
   - **Name:** `payasitos-salas` (así la dirección será `payasitos-salas.onrender.com`)
   - **Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
3. **Deploy Web Service**. Cuando termine, abre la dirección que te da: debe decir
   `payasitos-salas ok 0`.

Si el nombre `payasitos-salas` ya está cogido, Render te dará otra dirección: hay que ponerla
en `SERVIDOR_SALAS` dentro de `autoloads/Net.gd` del juego (con `wss://` delante).

## Límites de seguridad

- Códigos de 6 letras al azar; un máximo de 12 intentos de unirse por minuto y por IP
  (la IP es la que añade el proxy de Render, que no se puede falsificar).
- Como mucho 20 conexiones abiertas y 5 salas nuevas por minuto por IP; 2000 salas en total.
- Si el anfitrión se va (o se despide al cerrar el juego), la sala se cierra al instante.
  Si se le cae la conexión, el servidor lo nota en unos 20 segundos.
- Al cargar una partida, el anfitrión puede pedir su código de antes y se le da si está libre.
- 4 jugadores por sala; mensajes de hasta 512 KB y 120 por segundo por conexión.
- Las salas se cierran cuando sale el anfitrión o a las 12 horas.
