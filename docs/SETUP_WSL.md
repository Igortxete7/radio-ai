# Instalación en Windows + WSL2

La emisión se ejecuta dentro de Ubuntu, con systemd. El repositorio de trabajo y el almacenamiento deben estar en el filesystem Linux, por ejemplo `/home/radio/projects/radio-ai`, para evitar problemas de permisos y rendimiento bajo `/mnt/c`.

En PowerShell con permisos de administrador:

```powershell
wsl --install -d Ubuntu-24.04
wsl --list --verbose
wsl -d Ubuntu-24.04
```

Comprueba dentro de Ubuntu:

```bash
cat /etc/os-release
ps -p 1 -o comm=
systemctl is-system-running
```

PID 1 debe ser `systemd`. Si no lo es, conserva las opciones existentes de `/etc/wsl.conf` y añade `[boot]` con `systemd=true`. Ejecuta después `wsl --shutdown` desde PowerShell y vuelve a abrir Ubuntu. `degraded` puede corresponder a servicios ajenos a la radio; inspecciona `systemctl --failed`.

```bash
mkdir -p ~/projects
cd ~/projects
git clone https://github.com/Igortxete7/radio-ai.git radio-ai
cd radio-ai
bash scripts/bootstrap-wsl.sh
npm ci
npm run db:generate
npm run db:migrate
npm run library:scan
npm run radio:check
npm run build
bash scripts/install-services.sh
bash scripts/smoke-stream.sh
```

El bootstrap instala FFmpeg, Icecast, SQLite, herramientas de compilación y Node 24 desde el archivo oficial verificado con SHA256. Configura el repositorio oficial de Liquidsoap con un canal explícito. Es repetible: conserva `.env`, audio existente y pistas del usuario; solo genera los ficheros de demostración que faltan. Las claves locales de Icecast y `ADMIN_TOKEN` se generan criptográficamente para los valores vacíos y no se imprimen. `.env` tiene permisos 0600. Configura las claves externas en ese archivo privado; la radio funciona sin ellas.

Los audios de demostración son tonos matemáticos sintetizados localmente, identificados como `Radio AI Demo`. Sirven para probar la cadena; sustitúyelos por música autorizada para una emisora pública. El bootstrap valida la decodificación de `storage/fallback/emergency.mp3`, obligatorio para arrancar.

## Versión de Liquidsoap

La especificación solicita 2.5.x. A 13 de octubre de 2026, el [repositorio oficial](https://repo.liquidsoap.info/) publica 2.5 como candidato `v2.5.0-rc1` y no ofrece ese canal para Ubuntu Noble. Su versión estable compatible con Ubuntu 24.04 es **2.4.6**. Por fiabilidad se fija `v2.4.6`, sin mezclar paquetes de otra distribución. El [script oficial de instalación](https://repo.liquidsoap.info/setup.sh) valida que el canal exista para la distribución y arquitectura. El diseño usa las APIs públicas de cola, eventos y servidor; cualquier actualización requiere repetir `radio:check`, pruebas del protocolo y smoke de audio.

El registro real de cada bootstrap queda en `storage/tmp/environment-versions.txt`, incluyendo SO, Node, npm, Liquidsoap, Icecast y FFmpeg. El entorno comprobado el 15 de octubre de 2026 es **Ubuntu 24.04.5 LTS (noble), systemd como PID 1, Node 24.21.0, npm 11.19.0, Liquidsoap 2.4.6, Icecast 2.4.4 y FFmpeg 6.1.1-3ubuntu5**. El paquete de Liquidsoap instalado es `1:2.4.6-ubuntu-noble-ocaml4.14.2-2`, procedente del repositorio oficial.

Se ejecutaron realmente el check de Liquidsoap, build de Next.js 16.4.0, protocolo TCP de colas y eventos, decodificación del stream, emisión con worker detenido y generación con clave OpenAI inválida. Esta última devolvió `OPENAI_AUTH` sin encolar audio mientras el stream seguía decodificándose. La prueba de ocho horas tiene un registro independiente y solo se acepta al completar su duración; consulta `OPERATIONS.md`.

## Entorno y acceso

El lanzador `radio/liquidsoap/run.sh` carga `.env` y exporta sus variables antes de ejecutar Liquidsoap. `.env` es configuración privada de confianza y debe conservar sintaxis compatible con Bash: usa comillas para espacios o JSON, como en `.env.example`. Las variables suministradas por systemd provienen de `/etc/radio-ai/radio.env`. El instalador copia allí el entorno con propietario `root:radio` y permisos 0640, fija `NODE_ENV=production` y convierte las rutas de storage y SQLite a absolutas sin modificar el `.env` del checkout.

El panel escucha en `127.0.0.1:3000`, Icecast en `127.0.0.1:8000` y el servidor de comandos de Liquidsoap en `127.0.0.1:1234`. El navegador de Windows puede acceder a [la emisión local](http://localhost:8000/radio.mp3) y [el panel](http://localhost:3000) mediante el reenvío localhost de WSL. No se abre el servidor de comandos a la LAN.

Para demostrar primero la cadena de audio, ejecuta `bash radio/icecast/configure.sh` y, como tu usuario no root, `bash radio/liquidsoap/run.sh`; en otra terminal ejecuta `bash scripts/smoke-stream.sh`. Esta prueba usa la playlist creada por el bootstrap y no necesita Node ni worker en ejecución. Después usa `npm run dev` para desarrollo con Liquidsoap e Icecast activos. Para servicios usa el build de producción y `bash scripts/install-services.sh`. Este último exige un build, permisos de lectura para el usuario no privilegiado `radio`, acceso a storage, ejecución de Node/npm por ese usuario y un emergency válido. Instala unidades nativas `radio-liquidsoap`, `radio-worker`, `radio-web` e `icecast2`: las tres primeras usan `radio`, y la última `icecast2`. Icecast se supervisa mediante su proceso real y se reinicia ante fallo.

## Mantener WSL activo

Desde el checkout de Windows:

```powershell
.\scripts\start-wsl.ps1
wsl -d Ubuntu-24.04 -u radio --exec systemctl is-active icecast2 radio-liquidsoap radio-worker radio-web
```

`start-wsl.ps1` crea una sesión oculta de WSL con `sleep infinity` y guarda su identidad en `storage/tmp/wsl-keeper.json`. Es necesario porque los servicios systemd por sí solos no mantienen la distribución abierta al cerrar la última sesión de Windows. La llamada es repetible. `stop-wsl.ps1` libera únicamente el proceso de continuidad registrado y verificado; WSL puede apagarse cuando no queden sesiones. Para detener servicios explícitamente usa systemd. Los helpers no configuran inicio automático de Windows.

El proyecto Linux instalado aquí está en `/home/radio/projects/radio-ai`. Conserva `.env`, DB y audio de ese directorio al sincronizar fuentes desde Windows; no copies `node_modules`, `.next` ni `.git` entre sistemas. Mantén el equipo despierto durante las pruebas. La suspensión, un reinicio de Windows o apagar WSL interrumpe la emisión; para 24/7 usa un servidor Ubuntu.

Referencia: [instalación WSL](https://learn.microsoft.com/windows/wsl/install), [systemd en WSL](https://learn.microsoft.com/windows/wsl/systemd), [repositorio Liquidsoap](https://repo.liquidsoap.info/).
