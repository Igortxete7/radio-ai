# Radio AI

Emisora musical automática con DJ de IA. Liquidsoap mantiene el audio; Icecast distribuye MP3 estéreo a 128 kbps; un worker de Node prepara contenidos y Next.js permite operar la estación. La música continúa si fallan la IA, la base de datos o el worker.

## Entorno

Node 24, Ubuntu 24.04 en WSL2 o VPS, FFmpeg, Icecast y Liquidsoap oficial compatible. No utiliza Docker. Mantén el proyecto de ejecución en el filesystem Linux; la carpeta Windows conserva el código editable. Consulta [SETUP_WSL](docs/SETUP_WSL.md) para instalación y versiones realmente verificadas.

```bash
bash scripts/bootstrap-wsl.sh
npm install
npm run env:init
npm run db:generate
npm run db:migrate
bash scripts/generate-demo-audio.sh
npm run library:scan
npm run radio:check
```

El bootstrap crea contraseñas locales aleatorias si faltan. Para el DJ real, añade OPENAI_API_KEY a `.env` local. El proveedor meteorológico inicial es Open-Meteo y los RSS se configuran con NEWS_SOURCES_JSON o desde el panel. Los audios de demostración son tonos sintetizados, no canciones comerciales. Sustitúyelos por música y jingles autorizados antes de usar la emisora públicamente.

```bash
bash scripts/install-services.sh
sudo systemctl enable --now radio-liquidsoap radio-worker radio-web
```

Panel: [http://localhost:3000](http://localhost:3000). Emisión: [http://localhost:8000/radio.mp3](http://localhost:8000/radio.mp3). Para acceder al panel, usa ADMIN_TOKEN de `.env`; nunca compartas este archivo. El panel informa que la voz del DJ está generada por IA.

En Windows, ejecuta `./scripts/start-wsl.ps1` para mantener abierta una sesión oculta de Ubuntu mientras funcionan los servicios. Systemd por sí solo no impide el apagado de una distribución WSL cuando se cierra su última sesión. `./scripts/stop-wsl.ps1` libera únicamente ese proceso de continuidad. El equipo debe permanecer encendido.

Para desarrollo, Icecast/Liquidsoap deben estar activos y `npm run dev` arranca web y worker. El panel se vincula a loopback. Un VPS requiere TLS/proxy y firewall: [DEPLOY_UBUNTU](docs/DEPLOY_UBUNTU.md).

Detrás de un proxy TLS, configura `ADMIN_ORIGIN=https://radio.example.com` y `STREAM_PUBLIC_URL=https://radio.example.com/radio.mp3`; el origen público protege las acciones administrativas y determina la cookie segura.

## Comprobaciones

```bash
npm run test
npm run lint
npm run typecheck
npm run build
npm run radio:check
npm run smoke
npx playwright install chromium
npm run test:e2e
```

Los tests usan SQLite temporal y servidores HTTP/TCP locales. No gastan créditos de OpenAI. Las pruebas reales del DJ requieren una clave y se ejecutan desde el panel. El registro de validación y las limitaciones se mantienen en [VALIDATION](docs/VALIDATION.md); una prueba breve no demuestra ocho horas de estabilidad.

## Operación

- Copia audio a storage/music y usa Reescanear o espera al scanner periódico.
- Los metadatos editados desde Biblioteca se conservan sin modificar el archivo original.
- Las intervenciones se preparan anticipadamente y entran entre canciones.
- La cola reconcilia solicitudes ambiguas para evitar repetir una locución tras reinicios.
- La continuidad conserva una playlist local y emergency.mp3 aunque no haya backend.
- Los secretos se administran en `.env`/EnvironmentFile; los cambios funcionales del panel quedan en SQLite.

Consulta [OPERATIONS](docs/OPERATIONS.md) para logs, backups y recuperación y [ARCHITECTURE](docs/ARCHITECTURE.md) para las responsabilidades de cada proceso. La especificación original está en [SPEC_RADIO_AI](docs/SPEC_RADIO_AI.md). Las ideas V2 de su anexo E quedan fuera del MVP.
