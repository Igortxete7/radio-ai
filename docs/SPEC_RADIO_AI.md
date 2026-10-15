Emisora de radio digitalcon DJ de IA

Especificación técnico-funcional para implementación con Windows + WSL2

| Objetivo del documento Servir como especificación ejecutable para que Codex pueda crear el repositorio, instalar el entorno, implementar el MVP, probarlo localmente en Windows + WSL2 y dejar preparada una migración limpia a un VPS Ubuntu. |

| --- |



Fecha: 7 de octubre de 2026

Estado: propuesta de arquitectura y backlog de implementación

Enfoque: MVP fiable primero; sofisticación editorial después

Decisión de arquitectura

Liquidsoap controla el audio. Icecast distribuye la señal. Node/TypeScript decide qué debe sonar y genera las intervenciones del DJ. Next.js aporta administración y observabilidad.

Índice


# 1. Resumen ejecutivo


# 2. Objetivos, alcance y principios


# 3. Arquitectura de solución


# 4. Stack tecnológico y decisiones


# 5. Entorno Windows + WSL2


# 6. Estructura del repositorio


# 7. Modelo de datos


# 8. Biblioteca musical e ingestión


# 9. Motor de programación musical


# 10. Liquidsoap: motor de audio


# 11. Icecast: servidor de streaming


# 12. DJ de IA: generación de guion


# 13. Text-to-Speech y personalidad de voz


# 14. Meteorología


# 15. Actualidad y fuentes de noticias


# 16. Scheduler e intervenciones horarias


# 17. Integración Backend-Liquidsoap


# 18. Panel de administración Next.js


# 19. API interna


# 20. Estado, logs y observabilidad


# 21. Seguridad y secretos


# 22. Tolerancia a fallos


# 23. Testing y QA


# 24. Puesta en marcha local


# 25. Migración a VPS Ubuntu


# 26. Fases de implementación


# 27. Criterios de aceptación del MVP


# 28. Backlog inicial para Codex


# 29. Prompt de arranque para Codex


# 30. Referencias oficiales

Anexos técnicos A-F


# 1. Resumen ejecutivo

La solución propuesta es una emisora digital automatizada 24/7. Reproduce música desde una biblioteca local, mantiene una cola inteligente de canciones y, en momentos programados, inserta locuciones generadas por IA con hora, meteorología, actualidad y referencias a la música emitida. La prioridad del MVP es que la señal de audio sea estable incluso si fallan Internet, OpenAI, una fuente RSS o el panel web.

El entorno de desarrollo será Windows con WSL2 y Ubuntu. Los procesos de radio se ejecutarán dentro de WSL2 como servicios Linux, utilizando systemd. Esta elección aproxima el entorno local al futuro servidor Ubuntu y reduce diferencias entre desarrollo y producción.

La arquitectura evita dos errores frecuentes: usar Node.js como motor de audio en tiempo real desde el primer día y hacer depender la emisión de las APIs de IA. Liquidsoap se responsabiliza del audio continuo; el backend solamente prepara contenidos y manipula colas. Si el backend deja de responder, la música debe continuar.

| Regla de oro La IA puede enriquecer la emisión, pero nunca debe ser un requisito para mantener la radio en antena. La ruta de fallback siempre es música + jingles preexistentes. |

| --- |




# 1.1 Resultado esperado del MVP

Una URL de streaming local, por ejemplo http://localhost:8000/radio.mp3.

Reproducción continua y aleatoria desde /storage/music.

Crossfade entre canciones y normalización básica de la señal.

Jingles insertados según reglas simples.

Intervención horaria del DJ generada automáticamente.

Locución con hora, tiempo, titulares y siguiente canción cuando la información esté disponible.

Panel web para ver estado, ahora suena, siguiente, historial y controles básicos.

Persistencia local en SQLite.

Servicios arrancables/reiniciables con systemd en WSL2.

Configuración por .env y sin secretos dentro del repositorio.

Pruebas automáticas de la lógica no-audio y smoke tests de la cadena de streaming.


# 2. Objetivos, alcance y principios


# 2.1 Objetivos funcionales

Emitir música 24/7 a partir de una carpeta que pueda crecer sin necesidad de reiniciar todo el sistema.

Evitar repeticiones cercanas de canción y artista.

Insertar intervenciones del DJ sin cortar una canción en el MVP.

Generar automáticamente intervenciones con información reciente.

Permitir configurar periodicidad, personalidad del DJ y reglas musicales desde variables/configuración.

Mostrar al administrador el estado real del sistema y los últimos eventos relevantes.

Poder migrar el mismo código a Ubuntu sin Docker.


# 2.2 Fuera de alcance del MVP

Mezcla de voz sobre la intro de una canción (voice tracking avanzado).

Procesamiento profesional de loudness con medición EBU R128 completa por catálogo.

Aplicaciones móviles nativas.

Peticiones de oyentes, WhatsApp o llamadas en directo.

Publicidad programática.

Clúster de alta disponibilidad o múltiples nodos de emisión.

Sistema completo de derechos musicales y reporting a entidades de gestión.


# 2.3 Principios de diseño

| Principio | Aplicación práctica |

| --- | --- |

| Audio primero | Liquidsoap e Icecast no deben depender del backend para seguir reproduciendo música. |

| Desacoplamiento | El backend genera archivos/órdenes; Liquidsoap los consume mediante cola o API local. |

| Idempotencia | Un job horario ejecutado dos veces no debe emitir dos veces la misma intervención. |

| Configurable | Modelos, voz, ubicación, RSS, periodicidades y reglas no se hardcodean. |

| Observable | Cada decisión importante deja evento y estado consultable. |

| Fallback explícito | Si falla TTS, noticias o tiempo, existe una variante degradada. |

| Portabilidad | Rutas relativas, systemd y scripts bash compatibles con WSL2 y Ubuntu servidor. |




# 3. Arquitectura de solución

La señal sigue una cadena unidireccional: Liquidsoap produce audio codificado, Icecast lo retransmite y los oyentes consumen el mountpoint. El backend no está en el camino crítico de cada frame de audio; solamente influye en la cola y en los ficheros que Liquidsoap reproducirá.


# 3.1 Componentes

| Componente | Responsabilidad | Tecnología |

| --- | --- | --- |

| radio-web | Panel de administración y APIs HTTP | Next.js + TypeScript |

| radio-core | Dominio: catálogo, scheduler, selección, jobs y adaptadores | Node.js + TypeScript |

| radio-worker | Jobs programados y generación de locuciones | Node.js + TypeScript |

| Liquidsoap | Continuidad de audio, colas, crossfade, metadatos, salida | Liquidsoap 2.5.x |

| Icecast | Servidor de distribución a oyentes | Icecast 2.5.x o paquete soportado |

| Base de datos | Catálogo, historial, jobs y configuración | SQLite para MVP |

| Almacenamiento | Música, jingles, locuciones y archivos temporales | Filesystem WSL2 |

| OpenAI | Generación de guion y TTS | Responses API + Speech API |

| Weather adapter | Datos meteorológicos | AEMET u Open-Meteo |

| News adapter | Titulares estructurados | RSS/Atom configurables |




# 3.2 Límites de responsabilidad

Liquidsoap decide cómo reproducir y encadenar audio, pero no decide la línea editorial de noticias.

El backend decide qué contenidos preparar, pero no debe mantener un stream PCM permanente.

Icecast no hace programación; solo recibe una fuente y distribuye el stream.

Next.js no debe alojar procesos infinitos de audio dentro del proceso del servidor web. Los jobs de larga vida se ejecutan en radio-worker.

La base de datos no almacena audio binario; almacena rutas, metadatos y estados.


# 4. Stack tecnológico y decisiones

| Área | Elección | Motivo |

| --- | --- | --- |

| Sistema local | WSL2 + Ubuntu LTS | Paridad con producción Linux y soporte systemd. |

| Runtime | Node.js 24 LTS | LTS activo a 7/10/2026; estable para producción. |

| Lenguaje | TypeScript | Tipos compartidos entre backend, worker y panel. |

| Frontend | Next.js 16 + React | Panel full-stack, familiar y fácil de desplegar. |

| UI | shadcn/ui + Geist | Interfaz limpia y consistente. |

| Persistencia | SQLite + Prisma | Cero infraestructura en MVP; migrable a PostgreSQL. |

| Audio | Liquidsoap 2.5.x | Diseñado para radio, colas, fallback, crossfade e Icecast. |

| Streaming | Icecast | Servidor específico y probado para radio por Internet. |

| Procesamiento | FFmpeg | Inspección/conversión auxiliar de audio. |

| IA texto | OpenAI Responses API | API recomendada actualmente para generación de texto. |

| TTS | gpt-4o-mini-tts | Modelo TTS actual con instrucciones de estilo. |

| Jobs | Proceso worker + node-cron o scheduler propio | Separado del web server; suficiente para un único nodo. |

| Tests | Vitest + Playwright + smoke scripts | Cobertura unitaria, API y UI. |



No se fijará el modelo de texto en código. La variable OPENAI_TEXT_MODEL será obligatoria o tendrá un valor por defecto documentado. De esta forma se puede ajustar coste, latencia o calidad sin modificar la lógica del dominio.


# 5. Entorno Windows + WSL2


# 5.1 Requisitos en Windows

Windows 11 actualizado.

Virtualización habilitada en BIOS/UEFI.

PowerShell con permisos de administrador para la instalación inicial.

Git y Visual Studio Code opcionales en Windows; el repositorio debe residir dentro del filesystem Linux de WSL, no bajo /mnt/c, para mejorar rendimiento de I/O.


# 5.2 Instalación base

# PowerShell como Administradorwsl --install# Después del reiniciowsl --versionwsl --list --verbose

La instalación estándar actual de WSL configura WSL2 e instala Ubuntu. Microsoft documenta systemd como predeterminado en la versión actual de Ubuntu instalada con wsl --install. Si no estuviese activo, se habilitará explícitamente en /etc/wsl.conf y se reiniciará WSL.

# Dentro de Ubuntu, si fuese necesariosudo nano /etc/wsl.conf[boot]systemd=true# Después, desde PowerShellwsl.exe --shutdown# Verificaciónwslsystemctl status


# 5.3 Directorio de trabajo recomendado

mkdir -p ~/projectscd ~/projectsgit clone <REPOSITORY_URL> radio-aicd radio-ai

| Evitar No desarrollar el repositorio principal dentro de C:\... accedido como /mnt/c/... salvo necesidad. Los proyectos Node con muchos ficheros pequeños suelen comportarse mejor dentro del filesystem Linux de WSL. |

| --- |




# 5.4 Paquetes del sistema

sudo apt updatesudo apt install -y git curl build-essential ffmpeg sqlite3 icecast2# Liquidsoap: usar repositorio oficial y fijar un canal estable compatible.curl -fsSL https://repo.liquidsoap.info/setup.sh | sudo shsudo apt updatesudo apt install -y liquidsoapliquidsoap --versionliquidsoap --build-configicecast2 -vffmpeg -version

Codex deberá registrar en docs/SETUP_WSL.md las versiones instaladas realmente. No debe asumir que el paquete distro y el paquete oficial de Liquidsoap coinciden.


# 5.5 Node.js

Para reproducibilidad se recomienda nvm o fnm dentro de WSL. A fecha del documento, Node.js 24 es LTS activo. El repositorio incluirá .nvmrc con 24 y engines en package.json.

# Ejemplo con nvmnvm install 24nvm use 24node --versionnpm --version


# 6. Estructura del repositorio

radio-ai/├── apps/│   ├── web/                  # Next.js admin│   └── worker/               # scheduler y jobs├── packages/│   ├── core/                 # dominio y casos de uso│   ├── db/                   # Prisma/SQLite│   ├── integrations/         # OpenAI, tiempo, RSS, Liquidsoap│   ├── config/               # schema de configuración│   └── shared/               # tipos y utilidades├── radio/│   ├── liquidsoap/│   │   └── radio.liq│   ├── icecast/│   │   └── icecast.xml.example│   └── systemd/│       ├── radio-worker.service│       └── radio-liquidsoap.service├── storage/│   ├── music/│   ├── jingles/│   ├── generated/│   ├── fallback/│   └── tmp/├── scripts/│   ├── bootstrap-wsl.sh│   ├── scan-library.ts│   ├── smoke-stream.sh│   └── install-services.sh├── docs/│   ├── SETUP_WSL.md│   ├── OPERATIONS.md│   └── ARCHITECTURE.md├── prisma/│   └── schema.prisma├── .env.example├── .nvmrc├── package.json└── README.md


# 6.1 Monorepo

El MVP puede utilizar npm workspaces para evitar introducir pnpm/turborepo si no aporta valor inmediato. Todos los paquetes deben compartir tsconfig base, linting y tipos. Codex puede introducir una herramienta de build de monorepo solo si existe una necesidad concreta y queda documentada.


# 7. Modelo de datos

El modelo debe separar la biblioteca física de la programación y del historial. Una canción puede existir y estar deshabilitada; un evento reproducido es una instancia histórica, no una propiedad de la canción.

| Entidad | Campos principales | Uso |

| --- | --- | --- |

| Track | id, path, title, artist, album, genre, durationSec, bpm?, enabled, hash | Biblioteca musical. |

| Jingle | id, path, name, category, durationSec, enabled | Identidad y transiciones. |

| PlayEvent | id, type, assetId?, title, artist?, startedAt, endedAt, status | Historial real de emisión. |

| QueueItem | id, type, assetId/path, priority, state, scheduledFor?, dedupeKey | Cola lógica del backend. |

| AiBreak | id, kind, scheduledFor, script, audioPath, status, contextJson, dedupeKey | Intervenciones generadas. |

| NewsItem | id, source, title, url, publishedAt, summary?, fingerprint | Caché y deduplicación. |

| WeatherSnapshot | id, location, observedAt, payloadJson | Caché de meteorología. |

| RadioSetting | key, valueJson, updatedAt | Configuración editable. |

| JobRun | id, jobName, scheduledFor, startedAt, endedAt, status, error | Idempotencia/observabilidad. |




# 7.1 Esquema Prisma orientativo

model Track {  id           String   @id @default(cuid())  path         String   @unique  title        String  artist       String  album        String?  genre        String?  durationSec  Float  enabled      Boolean  @default(true)  contentHash  String?  lastPlayedAt DateTime?  playCount    Int      @default(0)  createdAt    DateTime @default(now())  updatedAt    DateTime @updatedAt}model AiBreak {  id           String   @id @default(cuid())  kind         String  scheduledFor DateTime  script       String?  audioPath    String?  status       String  dedupeKey    String   @unique  contextJson  Json?  createdAt    DateTime @default(now())}


# 8. Biblioteca musical e ingestión


# 8.1 Flujo


# 1. El usuario copia MP3/M4A/FLAC compatibles a storage/music.


# 2. Un scanner recorre la carpeta periódicamente y al arrancar.


# 3. Se extraen metadatos y duración.


# 4. Se calcula hash opcional para detectar duplicados.


# 5. Se da de alta o actualiza Track.


# 6. Los ficheros eliminados se marcan missing/disabled; no se destruye su historial.


# 8.2 Requisitos del scanner

Recursivo por subcarpetas.

Extensiones configurables.

No bloquear la radio.

Procesar cambios de forma incremental cuando sea posible.

Tolerar metadatos ausentes derivando artista/título del filename.

Registrar errores por fichero sin abortar el escaneo completo.

No modificar el audio original en el MVP.


# 8.3 Convención de nombres

No es obligatoria, pero si faltan tags ID3 se intentará interpretar "Artista - Título.ext". Si no es posible, title será el nombre base del archivo y artist será "Desconocido". El panel debe permitir corregir metadatos lógicos sin renombrar el archivo.


# 9. Motor de programación musical


# 9.1 Selección MVP

La selección no debe usar un ORDER BY RANDOM puro como criterio único. Debe aplicar exclusiones y después aleatoriedad ponderada.

candidates = enabled tracks  - tracks played in last TRACK_REPEAT_HOURS  - artists played in last ARTIST_REPEAT_MINUTES  - missing/unreadable filesscore(track) = random(0..1)             + freshnessWeight(track.lastPlayedAt)             + underplayedWeight(track.playCount)select highest score from a bounded candidate sample


# 9.2 Valores iniciales

| Regla | Default MVP | Configurable |

| --- | --- | --- |

| No repetir canción | 24 h | Sí |

| No repetir artista | 90 min | Sí |

| Jingle | cada 5-8 canciones | Sí |

| Intervención corta DJ | desactivada | Sí, fase posterior |

| Intervención horaria | cada hora | Sí |

| Crossfade | 5 s | Sí |




# 9.3 Ausencia de candidatos

Si la biblioteca es pequeña y las restricciones dejan cero candidatos, el selector relajará reglas en orden explícito: primero repetición de artista, después repetición de pista. Siempre debe registrar la relajación aplicada.


# 10. Liquidsoap: motor de audio

Liquidsoap es el componente crítico de continuidad. Debe poder arrancar con una playlist local aunque el backend, la base de datos o Internet estén caídos.


# 10.1 Fuentes de audio

music: playlist local aleatorizada o lista dinámica.

priority_queue: request.queue para locuciones/jingles urgentes.

fallback: fichero o playlist segura si no hay música válida.

radio: combinación de prioridad y música, con crossfade donde proceda.


# 10.2 Estrategia recomendada de integración

El backend generará un fichero de locución y lo insertará en una cola interactiva de Liquidsoap. Liquidsoap documenta request.queue con comandos push, queue, remove, skip y flush_and_skip a través de su command server. Codex debe encapsular esta interacción en LiquidsoapClient para que el resto del dominio no dependa del protocolo concreto.


# 10.3 Boceto de radio.liq

# Boceto orientativo: Codex debe validarlo contra la versión instalada.settings.log.stdout.set(true)# Cola de elementos prioritarios: DJ, jingles, avisos.priority = request.queue(id="priority")# Música de continuidad.music = playlist(mode="randomize", reload_mode="watch", "./storage/music")# Fallback final para garantizar audio.fallback_audio = single("./storage/fallback/emergency.mp3")base = fallback(track_sensitive=false, [music, fallback_audio])# Crossfade solo sobre el flujo musical/base.base = crossfade(duration=5.0, base)# La cola prioritaria entra en límites de pista por defecto.radio = fallback([priority, base])radio = mksafe(radio)output.icecast(  %mp3(bitrate=128),  host="127.0.0.1",  port=8000,  password=getenv("ICECAST_SOURCE_PASSWORD"),  mount="/radio.mp3",  name="Radio AI",  radio)

| Validación obligatoria por Codex La sintaxis de Liquidsoap evoluciona. Codex debe ejecutar liquidsoap --check radio/liquidsoap/radio.liq y ajustar el script a la versión instalada antes de considerar terminada esta tarea. |

| --- |




# 10.4 Metadatos

Para música, Icecast debe recibir artist/title cuando existan. Para locuciones se publicará algo como "Radio AI - Actualidad y tiempo". El backend debe disponer del estado "now playing" aunque el metadata del stream tarde en actualizarse; por eso se mantendrá historial interno y se integrarán callbacks/comandos de Liquidsoap cuando sea práctico.


# 11. Icecast: servidor de streaming

Icecast recibe el stream desde Liquidsoap mediante un mountpoint, por ejemplo /radio.mp3. El servidor gestiona oyentes, límites, estado y credenciales de fuente. La configuración local debe escuchar en 127.0.0.1 o red local según necesidad; en producción se protegerá mediante firewall/reverse proxy si se publica.


# 11.1 Configuración local mínima

<!-- Fragmento orientativo de /etc/icecast2/icecast.xml --><hostname>localhost</hostname><listen-socket>  <port>8000</port>  <bind-address>0.0.0.0</bind-address></listen-socket><authentication>  <source-password>CHANGE_ME</source-password>  <relay-password>CHANGE_ME</relay-password>  <admin-user>admin</admin-user>  <admin-password>CHANGE_ME</admin-password></authentication>

Los secretos reales no deben versionarse. En local se puede templar la configuración mediante script de instalación o documentar el paso manual. El backend no necesita conocer admin-password para el MVP.


# 11.2 URL de escucha

http://localhost:8000/radio.mp3


# 11.3 Formato

El MVP emitirá MP3 128 kbps estéreo por compatibilidad. Una fase posterior puede añadir Opus/AAC en mountpoints adicionales. Liquidsoap permite múltiples outputs desde una misma fuente, aunque cada output puede implicar su propia codificación.


# 12. DJ de IA: generación de guion


# 12.1 Pipeline


# 12.2 Contexto de entrada

fecha/hora local y zona Europe/Madrid;

nombre de emisora y personalidad;

meteorología normalizada;

titulares seleccionados y sus fuentes;

canción anterior, actual o siguiente cuando esté disponible;

duración objetivo;

reglas editoriales;

tipo de intervención: hourly, weather, news, music-link, ident.


# 12.3 Contrato de salida

No pedir únicamente texto libre. El modelo devolverá JSON estructurado para validar duración, contenido y trazabilidad antes del TTS.

{  "opening": "Son las diez...",  "body": "...",  "closing": "Seguimos con...",  "fullText": "...",  "mentionedNewsIds": ["..."],  "mentionsWeather": true,  "mentionsNextTrack": true,  "estimatedSeconds": 52}


# 12.4 Instrucciones editoriales

Idioma por defecto: español de España.

Tono: cercano, ágil y de radio musical; no asistente virtual.

No inventar datos que no estén en el contexto.

No leer URLs, identificadores ni listas mecánicamente.

Distinguir claramente hechos de previsiones meteorológicas.

Noticias: resumir; no reproducir textos extensos.

Evitar afirmaciones no verificadas o sensacionalistas.

Si una fuente está vacía, omitirla de manera natural.

No decir “según los datos proporcionados”.

Duración objetivo configurable, inicialmente 45-70 segundos.


# 12.5 Prompt base orientativo

INSTRUCTIONS:Eres el DJ de una emisora musical automatizada. Escribe para ser escuchado, no leído.Mantén un tono natural, cercano y profesional. No inventes hechos. Usa solo CONTEXT.Devuelve exclusivamente el JSON solicitado.CONTEXT:- Local time: {{localTime}}- Weather: {{weather}}- News candidates: {{news}}- Previous track: {{previousTrack}}- Next track: {{nextTrack}}- Target duration: {{targetSeconds}} seconds- Station persona: {{persona}}


# 12.6 API OpenAI

La integración de texto utilizará el SDK oficial de JavaScript y Responses API. El nombre del modelo se leerá de OPENAI_TEXT_MODEL. Debe implementarse timeout, reintentos acotados y logging sin almacenar la API key.


# 13. Text-to-Speech y personalidad de voz

La locución se generará mediante el endpoint Speech de OpenAI. El modelo recomendado en la documentación actual es gpt-4o-mini-tts y permite instrucciones de tono, velocidad e interpretación.


# 13.1 Configuración

OPENAI_TTS_MODEL=gpt-4o-mini-ttsOPENAI_TTS_VOICE=marinDJ_LANGUAGE=es-ESDJ_TARGET_SECONDS=55

La voz debe ser configurable. La documentación actual recomienda marin o cedar para calidad, pero Codex no debe asumir que una voz concreta seguirá disponible indefinidamente.


# 13.2 Prompt de estilo TTS

Locución de radio musical en español de España.Tono cercano y seguro, con energía moderada.Ritmo ágil pero inteligible.Pausas naturales entre hora, tiempo, actualidad y enlace musical.No sonar como asistente virtual ni como anuncio publicitario.Pronunciar nombres propios con naturalidad y evitar dramatización.


# 13.3 Salida de audio

Guardar en storage/generated/YYYY/MM/DD/<dedupeKey>.mp3. Antes de encolarlo se comprobará: fichero existente, tamaño > 0, duración dentro de rango razonable y decodificación correcta mediante ffprobe.

ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 storage/generated/...mp3


# 13.4 Transparencia

La experiencia pública debe identificar de forma clara que la voz del locutor es generada por IA. La documentación oficial de OpenAI exige esta divulgación para TTS.


# 14. Meteorología


# 14.1 Abstracción

Crear una interfaz WeatherProvider para no acoplar el dominio a un proveedor. La primera implementación puede usar AEMET por autoridad local o Open-Meteo por simplicidad. La selección se realizará mediante WEATHER_PROVIDER.

interface WeatherProvider {  getCurrentAndForecast(location: RadioLocation): Promise<WeatherBrief>}type WeatherBrief = {  observedAt: string;  temperatureC?: number;  apparentTemperatureC?: number;  condition?: string;  precipitationProbabilityPct?: number;  maxC?: number;  minC?: number;  windKph?: number;  sourceName: string;};


# 14.2 Reglas

Cachear snapshots y no llamar a la API para cada request del panel.

Si datos > WEATHER_MAX_AGE_MINUTES, marcarlos stale.

Si el proveedor falla, permitir que el DJ omita el tiempo o use el último snapshot indicando solo datos que sigan siendo válidos.

No convertir códigos meteorológicos con el LLM; normalizarlos en código antes del prompt.


# 15. Actualidad y fuentes de noticias


# 15.1 Estrategia MVP

No construir un crawler general. Utilizar feeds RSS/Atom y/o APIs expresamente configuradas. Cada fuente tendrá nombre, URL, categoría, prioridad e idioma. El sistema obtiene titulares, deduplica y selecciona candidatos. El LLM solamente redacta; la selección primaria debe poder auditarse.


# 15.2 Modelo de configuración

NEWS_SOURCES_JSON=[  {"name":"Fuente local","url":"https://.../rss","category":"local","priority":100},  {"name":"Fuente general","url":"https://.../rss","category":"general","priority":80}]


# 15.3 Pipeline


# 1. Fetch con timeout y User-Agent identificable.


# 2. Parseo RSS/Atom.


# 3. Normalización de title, url, publishedAt, source.


# 4. Fingerprint por URL canónica o hash de title normalizado.


# 5. Filtro por antigüedad máxima.


# 6. Ranking por prioridad, actualidad y categoría.


# 7. Selección de 3-5 candidatos para el prompt.


# 8. Guardar IDs mencionados por el guion para trazabilidad.


# 15.4 Seguridad editorial

No usar una sola fuente para asuntos controvertidos cuando pueda evitarse.

No inventar contexto faltante.

Mantener enlace al origen en el panel para revisión.

Permitir desactivar una fuente sin desplegar código.

Añadir blacklist de términos/categorías si el propietario de la emisora lo requiere.


# 16. Scheduler e intervenciones horarias


# 16.1 Estrategia temporal

El worker prepara la intervención varios minutos antes de la hora y la encola cuando esté lista. En el MVP no se interrumpe una canción para dar una hora exacta; la locución entra en el primer límite de pista razonable.

| Momento | Acción |

| --- | --- |

| T-5 min | Crear/asegurar JobRun para la próxima hora. |

| T-4:50 | Obtener/cargar weather y news. |

| T-4:20 | Generar guion y validar schema. |

| T-3:40 | Generar TTS. |

| T-3:10 | Validar MP3 y dejar AiBreak READY. |

| T-1 min | Encolar si no estaba encolado. |

| Límite de pista | Liquidsoap reproduce la intervención. |

| Después | Vuelve automáticamente a música. |




# 16.2 Idempotencia

La clave dedupeKey puede ser hourly:2026-10-07T10:00:00+02:00. Debe existir índice único. Si el scheduler corre dos veces, reutiliza el AiBreak existente y no duplica la cola.


# 16.3 Fallback

Si falla noticias: guion con hora + tiempo + música.

Si falla tiempo: hora + noticias + música.

Si falla generación de texto: jingle horario pregrabado o se omite el break.

Si falla TTS: no se encola nada generado; la música continúa.

Si el audio está corrupto: marcar FAILED y nunca encolarlo.


# 17. Integración Backend-Liquidsoap


# 17.1 Adaptador

interface RadioAutomationPort {  push(uri: string, metadata?: Record<string,string>): Promise<string>;  queue(): Promise<AutomationQueueItem[]>;  remove(id: string): Promise<void>;  skip(): Promise<void>;  health(): Promise<{ok: boolean; detail?: string}>;}

LiquidsoapClient implementará este puerto usando el command server/API soportada por la versión instalada. La implementación concreta queda aislada en packages/integrations.


# 17.2 Seguridad local

El command server de Liquidsoap debe quedar vinculado únicamente a localhost/Unix socket cuando sea posible. No debe exponerse directamente a la LAN ni a Internet.


# 17.3 Estado now-playing

El backend debe poder reconstruir el estado usando eventos/callbacks o consulta a Liquidsoap/Icecast. Como mínimo se guardará el último evento conocido y se mostrará un indicador de confianza/actualización en el panel.


# 18. Panel de administración Next.js


# 18.1 Diseño

Interfaz Geist/shadcn, fondo claro, navegación lateral discreta y foco en operación. No convertir cada dato en una tarjeta. Priorizar jerarquía, tablas, estado, timeline y acciones contextualizadas.


# 18.2 Navegación MVP

| Sección | Contenido |

| --- | --- |

| En directo | Estado general, reproductor, ahora suena, siguiente, nivel de salud y acciones rápidas. |

| Cola | Próximos elementos, tipo, prioridad, origen y posibilidad de retirar/forzar. |

| Biblioteca | Tracks, filtros, búsqueda, habilitar/deshabilitar, metadata, último uso. |

| DJ IA | Persona, voz, frecuencia, duración, prueba de guion y prueba TTS. |

| Programación | Intervenciones horarias y reglas de jingle. |

| Fuentes | Meteorología y RSS con estado del último fetch. |

| Historial | Timeline de canciones, jingles e intervenciones. |

| Sistema | Estado Icecast/Liquidsoap/worker, versiones y últimos errores. |

| Configuración | Variables funcionales no secretas. |




# 18.3 Pantalla En directo

Indicador LIVE/OFFLINE basado en health real.

Reproductor HTML5 apuntando al mountpoint.

Ahora suena: artista, título, inicio y duración estimada.

Siguiente elemento si está disponible.

Última intervención del DJ y próxima prevista.

Últimos 10 eventos.

Botones: generar prueba DJ, reescanear biblioteca, refrescar fuentes.

Botón Skip protegido con confirmación.


# 18.4 No guardar secretos desde UI en MVP

Las API keys y contraseñas de Icecast se gestionan mediante .env/systemd EnvironmentFile. La UI solo muestra si están configuradas, nunca el valor.


# 19. API interna

| Método | Ruta | Descripción |

| --- | --- | --- |

| GET | /api/health | Salud agregada. |

| GET | /api/now-playing | Estado actual. |

| GET | /api/queue | Cola lógica/automation. |

| POST | /api/queue/skip | Saltar elemento actual; admin. |

| POST | /api/library/scan | Lanzar escaneo. |

| GET | /api/tracks | Listado paginado. |

| PATCH | /api/tracks/:id | Editar metadata lógica/estado. |

| POST | /api/ai-breaks/preview | Generar guion sin encolar. |

| POST | /api/ai-breaks/test-tts | Generar muestra TTS. |

| POST | /api/ai-breaks/generate | Generar break manual. |

| GET | /api/history | Historial. |

| GET | /api/sources/status | Estado weather/news. |




# 19.1 Convenciones

JSON consistente con {data,error,meta}.

Errores tipados con code estable.

Validación con Zod en límites HTTP/configuración.

Fechas ISO 8601 con offset o UTC internamente.

Zona editorial explícita Europe/Madrid.

No exponer stack traces al cliente en producción.


# 20. Estado, logs y observabilidad


# 20.1 Healthchecks

| Check | OK | Degradado/Fallo |

| --- | --- | --- |

| Database | consulta simple válida | DB inaccesible |

| Library | >=1 track playable | 0 tracks |

| Liquidsoap | proceso + command health | inaccesible |

| Icecast | mountpoint/source disponible | sin source |

| Worker | heartbeat reciente | heartbeat vencido |

| OpenAI | no se chequea en bucle; último job | fallos recientes |

| Weather | snapshot fresco | stale/error |

| News | fetch reciente | stale/error |




# 20.2 Logging

Usar logs JSON estructurados en worker/core y texto legible en desarrollo. Campos mínimos: timestamp, level, service, event, correlationId/jobRunId, durationMs y errorCode. No registrar claves ni prompts completos si contienen información sensible.


# 20.3 Dashboard técnico

La pantalla Sistema mostrará versión Node, Liquidsoap, Icecast, uptime, último heartbeat, uso de disco de storage/generated y últimos errores. Para el MVP no es necesario Prometheus/Grafana.


# 21. Seguridad y secretos


# 21.1 .env.example

NODE_ENV=developmentTZ=Europe/MadridDATABASE_URL=file:./dev.dbOPENAI_API_KEY=OPENAI_TEXT_MODEL=OPENAI_TTS_MODEL=gpt-4o-mini-ttsOPENAI_TTS_VOICE=marinWEATHER_PROVIDER=aemetAEMET_API_KEY=RADIO_LATITUDE=RADIO_LONGITUDE=RADIO_LOCATION_NAME=Donostia / San SebastianICECAST_HOST=127.0.0.1ICECAST_PORT=8000ICECAST_MOUNT=/radio.mp3ICECAST_SOURCE_PASSWORD=TRACK_REPEAT_HOURS=24ARTIST_REPEAT_MINUTES=90DJ_HOURLY_ENABLED=trueDJ_PREPARE_MINUTES_BEFORE=5


# 21.2 Reglas

.env en .gitignore.

.env.example sin secretos.

Permisos restrictivos para EnvironmentFile en producción.

APIs administrativas protegidas antes de publicar el panel fuera de localhost/LAN.

No interpolar valores no confiables en shell commands. Usar spawn/execFile con argumentos.

Validar rutas de ficheros para impedir path traversal.


# 22. Tolerancia a fallos

| Fallo | Comportamiento requerido |

| --- | --- |

| OpenAI no responde | No detener radio; omitir intervención o usar fallback. |

| RSS falla | Seguir con otras fuentes o sin noticias. |

| Weather falla | Usar último snapshot válido o omitir. |

| DB temporalmente bloqueada | Liquidsoap sigue; worker reintenta de forma acotada. |

| Liquidsoap cae | systemd reinicia; Icecast puede quedarse sin source brevemente. |

| Icecast cae | systemd reinicia; Liquidsoap reintenta conexión. |

| MP3 corrupto | Scanner lo marca; selector no lo utiliza. |

| Carpeta sin música | Emergency loop/fallback y health crítico. |

| Disco lleno | No generar TTS; alerta; conservar reproducción de existentes. |

| Worker cae | systemd reinicia; jobs idempotentes recuperan próximas tareas. |




# 22.1 Archivo de emergencia

storage/fallback/emergency.mp3 será obligatorio y se validará en bootstrap. Puede ser un loop musical libre/preparado para pruebas. En producción debe utilizar material autorizado.


# 23. Testing y QA


# 23.1 Unit tests

Selector musical y relajación de restricciones.

Dedupe de noticias.

Construcción de WeatherBrief.

DedupeKey del scheduler y límites horarios DST.

Validación schema de respuesta LLM.

Reglas de fallback.

Rutas seguras de storage.


# 23.2 Integration tests

SQLite real temporal con Prisma.

Mock HTTP para weather/RSS/OpenAI.

LiquidsoapClient contra una interfaz simulada y, en suite opcional, contra Liquidsoap real.

Generación de un AiBreak completo usando TTS mock.


# 23.3 Smoke test de emisión

# 1. Comprobar Icecastcurl -fsS http://localhost:8000/status-json.xsl >/dev/null# 2. Comprobar mountpointcurl -I --max-time 5 http://localhost:8000/radio.mp3# 3. Capturar 10 segundos y validar decodificaciónffmpeg -y -t 10 -i http://localhost:8000/radio.mp3 -f null -


# 23.4 E2E panel

Dashboard carga y muestra estado.

Biblioteca lista tracks.

Generar preview DJ muestra texto validado.

Acciones administrativas muestran confirmación y resultado.

Errores de backend se representan de forma comprensible.


# 24. Puesta en marcha local


# 24.1 Secuencia de primera instalación


# 1. Instalar WSL2/Ubuntu.


# 2. Clonar repo dentro de ~/projects.


# 3. Ejecutar scripts/bootstrap-wsl.sh.


# 4. Copiar .env.example a .env y completar secretos.


# 5. Crear storage/music y añadir al menos 5 pistas de prueba.


# 6. Añadir storage/fallback/emergency.mp3.


# 7. Ejecutar npm install.


# 8. Ejecutar migraciones Prisma.


# 9. Configurar y arrancar Icecast.


# 10. Validar radio.liq.


# 11. Arrancar Liquidsoap.


# 12. Arrancar worker.


# 13. Arrancar Next.js.


# 14. Abrir panel y stream.


# 15. Ejecutar smoke tests.


# 24.2 Comandos de desarrollo esperados

npm installnpm run db:migratenpm run library:scannpm run dev          # web + worker si se implementa runner conjuntonpm run testnpm run lintnpm run typechecknpm run radio:check  # liquidsoap --checknpm run smoke


# 24.3 Systemd en WSL2

# Ejemplo conceptualsudo cp radio/systemd/radio-worker.service /etc/systemd/system/sudo cp radio/systemd/radio-liquidsoap.service /etc/systemd/system/sudo systemctl daemon-reloadsudo systemctl enable --now icecast2sudo systemctl enable --now radio-liquidsoapsudo systemctl enable --now radio-workersystemctl status radio-liquidsoapjournalctl -u radio-worker -f


# 25. Migración a VPS Ubuntu

El paso a producción no debe requerir reescribir arquitectura. Se instalarán los mismos componentes en Ubuntu Server y se sustituirá localhost público por dominio/reverse proxy según necesidades.


# 25.1 Diferencias principales

| Local WSL2 | VPS Ubuntu |

| --- | --- |

| Acceso localhost/LAN | Dominio público y firewall. |

| SQLite local | SQLite puede mantenerse inicialmente; PostgreSQL cuando sea necesario. |

| Secretos .env | EnvironmentFile con permisos + gestión de secretos del proveedor. |

| Icecast puerto 8000 | Puede quedar interno detrás de proxy/TLS o usar TLS propio. |

| Next dev | next build + next start/systemd. |

| Sin backup formal | Backup DB + configuración + generated opcional. |

| Uptime de PC | Servidor siempre encendido. |




# 25.2 Reverse proxy

Nginx o Caddy puede terminar HTTPS para panel y stream. No es requisito del MVP local. Al publicar, validar buffering, headers y conexiones largas para audio.


# 25.3 Operación

systemd Restart=on-failure para worker/Liquidsoap.

Rotación de logs.

Health endpoint externo.

Alertas de disco y mountpoint offline.

Backup periódico de SQLite y configuración.


# 26. Fases de implementación

| Fase | Objetivo | Salida |

| --- | --- | --- |

| 0. Bootstrap | Entorno y repo reproducible | WSL setup + monorepo + docs. |

| 1. Radio base | Audio continuo local | Icecast + Liquidsoap + música + fallback. |

| 2. Dominio | Catálogo y selección | SQLite + scanner + historial + selector. |

| 3. DJ IA | Generación completa | Weather/news + guion + TTS + fichero. |

| 4. Automatización | Inserción horaria fiable | Scheduler + queue + idempotencia. |

| 5. Panel | Operación visual | Dashboard, biblioteca, IA, sistema. |

| 6. Hardening | Fallos, tests, servicios | systemd + smoke + recovery. |

| 7. Producción | VPS Ubuntu | Guía deployment y HTTPS. |




# 26.1 Orden obligatorio

Codex no debe empezar por el panel. La primera demo debe ser: música -> Liquidsoap -> Icecast -> navegador/VLC. Después catálogo; después IA; después panel. Esto reduce el riesgo de construir una interfaz bonita sobre una cadena de audio no validada.


# 27. Criterios de aceptación del MVP

☐ La radio reproduce al menos 8 horas sin intervención manual en una prueba de estabilidad.

☐ Añadir un MP3 a storage/music y ejecutar/esperar scanner lo incorpora sin reiniciar Icecast.

☐ La selección respeta ventanas de repetición cuando la biblioteca lo permite.

☐ Si se detiene el worker, la música continúa.

☐ Si OPENAI_API_KEY es inválida, la música continúa y el fallo aparece en logs/panel.

☐ Cada hora se genera como máximo una intervención por dedupeKey.

☐ Una intervención válida se escucha entre canciones, no cortando arbitrariamente la pista del MVP.

☐ El stream se reproduce desde navegador/VLC mediante /radio.mp3.

☐ El panel muestra now playing, historial y health de componentes.

☐ Los secretos no aparecen en Git ni en respuestas API.

☐ Los comandos README permiten reinstalar el entorno desde cero.

☐ Codex deja tests, lint y typecheck en verde.


# 28. Backlog inicial para Codex

Este backlog está intencionadamente ordenado. Cada bloque debe producir un commit funcional y verificable antes de continuar.

| ID | Tarea |

| --- | --- |

| B01 - Bootstrap monorepo | Crear npm workspaces, TypeScript, lint, Vitest, .nvmrc Node 24, .env.example y README. |

| B02 - Bootstrap WSL | Crear scripts/bootstrap-wsl.sh y docs/SETUP_WSL.md. No ejecutar cambios destructivos sin confirmación. |

| B03 - Icecast local | Documentar/configurar Icecast, passwords locales, health check y /radio.mp3. |

| B04 - Liquidsoap mínimo | radio.liq con playlist + fallback + output.icecast. Validar con --check. |

| B05 - Smoke stream | Script que valida status, mountpoint y decodificación de 10 s. |

| B06 - Prisma/SQLite | Crear schema inicial, migración y package db. |

| B07 - Scanner | Recorrer storage/music, metadata/duración, upsert Track, errores por fichero. |

| B08 - Selector | Implementar no repetición, aleatoriedad ponderada y unit tests. |

| B09 - Historial | Registrar PlayEvent/now-playing con mecanismo viable en Liquidsoap. |

| B10 - Cola Liquidsoap | Implementar request.queue y LiquidsoapClient; push/queue/remove/skip. |

| B11 - Weather | WeatherProvider + AEMET/Open-Meteo inicial + cache. |

| B12 - RSS | NewsProvider, parse, normalización, dedupe y ranking. |

| B13 - OpenAI texto | Responses API + schema validado + retries/timeout. |

| B14 - TTS | Speech API, generación MP3, ffprobe y almacenamiento. |

| B15 - AiBreak service | Orquestar contexto -> guion -> TTS -> READY. |

| B16 - Scheduler | Job horario, dedupeKey, preparación anticipada y recuperación. |

| B17 - Enqueue | Insertar break preparado en Liquidsoap sin duplicados. |

| B18 - Next.js admin shell | Layout Geist/shadcn y navegación. |

| B19 - Dashboard | Health, now playing, queue, next AI break e historial. |

| B20 - Biblioteca | Tabla, filtros, scan y enable/disable. |

| B21 - DJ IA | Preview de guion/TTS y configuración no secreta. |

| B22 - Systemd | Units para worker/Liquidsoap/web y script install-services. |

| B23 - Resiliencia | Pruebas de caída de OpenAI/RSS/weather/worker. |

| B24 - Operación | docs/OPERATIONS.md, logs, backups y troubleshooting. |

| B25 - Producción | docs/DEPLOY_UBUNTU.md y checklist VPS. |




# 29. Prompt de arranque para Codex

Copiar el siguiente prompt junto con este documento o colocar la especificación en docs/SPEC_RADIO_AI.md y pedir a Codex que la lea completa antes de modificar archivos.

Actúa como lead engineer del proyecto Radio AI.Lee completa la especificación técnico-funcional antes de implementar. El objetivo es construir el MVP en Windows + WSL2, sin Docker, con Liquidsoap como motor de audio, Icecast como servidor de streaming, Node/TypeScript para dominio y worker, Next.js para administración y SQLite para persistencia.REGLAS DE TRABAJO:1. No reimplementes el motor de streaming en Node.2. La música debe seguir sonando aunque fallen OpenAI, noticias, meteorología o el worker.3. Trabaja el backlog en orden B01 -> B25.4. Antes de cada bloque, inspecciona el estado real del repositorio y no sobrescribas trabajo existente sin necesidad.5. Tras cada bloque ejecuta las validaciones relevantes: tests, lint, typecheck y, para Liquidsoap, liquidsoap --check.6. Mantén secretos fuera de Git.7. Toda integración externa debe estar detrás de una interfaz/adaptador y tener timeout/fallback.8. Usa configuración por entorno para modelos OpenAI, voz, ubicación y reglas musicales.9. Documenta comandos que realmente hayas validado en WSL2.10. Si una API o sintaxis depende de versión, comprueba la versión instalada antes de codificar.EMPIEZA AHORA POR B01-B05.Primero muestra brevemente qué archivos vas a crear/modificar. Después implementa. Al terminar, ejecuta las comprobaciones posibles y deja un resumen con: archivos creados, comandos ejecutados, resultado, riesgos pendientes y siguiente bloque recomendado.No empieces por el panel web: la primera meta verificable es obtener audio continuo desde storage/music -> Liquidsoap -> Icecast -> http://localhost:8000/radio.mp3.


# 30. Referencias oficiales verificadas

R1 - Microsoft: instalación WSL: https://learn.microsoft.com/windows/wsl/install

R2 - Microsoft: systemd en WSL: https://learn.microsoft.com/windows/wsl/systemd

R3 - Liquidsoap: instalación: https://www.liquidsoap.info/doc-dev/install.html

R4 - Liquidsoap: quickstart: https://www.liquidsoap.info/doc-dev/quick_start

R5 - Liquidsoap: requests/request.queue: https://www.liquidsoap.info/doc-dev/requests

R6 - Liquidsoap: Icecast output: https://www.liquidsoap.info/doc-dev/icecast

R7 - Liquidsoap: crossfade: https://www.liquidsoap.info/doc-dev/crossfade

R8 - Icecast: configuración: https://www.icecast.org/docs/icecast-latest/config_file/

R9 - Icecast: download/releases: https://icecast.org/download/

R10 - OpenAI: text generation/Responses API: https://developers.openai.com/api/docs/guides/text

R11 - OpenAI: text-to-speech: https://developers.openai.com/api/docs/guides/text-to-speech

R12 - AEMET OpenData: https://www.aemet.es/es/datos_abiertos/AEMET_OpenData

R13 - Node.js releases: https://nodejs.org/en/about/previous-releases

Las referencias se incluyen para que Codex pueda comprobar sintaxis y comportamiento dependiente de versión antes de implementar. La especificación prima como diseño, pero nunca debe sustituir la validación contra la versión realmente instalada.


# Anexo A. Contratos TypeScript sugeridos

export type TrackRef = {  id: string;  path: string;  title: string;  artist: string;  durationSec: number;};export type DjBreakContext = {  kind: "hourly" | "weather" | "news" | "music-link" | "ident";  localTimeIso: string;  timezone: string;  weather?: WeatherBrief;  news: NewsCandidate[];  previousTrack?: TrackRef;  nextTrack?: TrackRef;  targetSeconds: number;  stationPersona: string;};export interface ScriptGenerator {  generate(context: DjBreakContext): Promise<GeneratedScript>;}export interface SpeechSynthesizer {  synthesize(text: string, options: SpeechOptions): Promise<GeneratedAudio>;}export interface NewsProvider {  fetchCandidates(now: Date): Promise<NewsCandidate[]>;}export interface WeatherProvider {  getCurrentAndForecast(location: RadioLocation): Promise<WeatherBrief>;}export interface RadioAutomationPort {  push(uri: string, metadata?: Record<string,string>): Promise<string>;  queue(): Promise<AutomationQueueItem[]>;  remove(id: string): Promise<void>;  skip(): Promise<void>;  health(): Promise<AutomationHealth>;}


# Anexo B. Estados del AiBreak

PLANNED -> GENERATING_CONTEXT -> GENERATING_SCRIPT -> GENERATING_AUDIO -> READY -> ENQUEUED -> PLAYED                          \-> FAILED              \-> FAILEDReglas:- FAILED conserva errorCode y retryable.- READY implica audioPath válido y verificado.- ENQUEUED implica queueRequestId conocido.- PLAYED se marca desde evento de reproducción, no al hacer push.- Un dedupeKey no puede tener dos AiBreak activos.


# Anexo C. Eventos de dominio mínimos

library.scan.started / completed / failed

track.discovered / missing / disabled

selection.track.chosen / constraints.relaxed

ai_break.planned / ready / failed / enqueued / played

weather.refresh.succeeded / failed

news.refresh.succeeded / failed

liquidsoap.connected / disconnected

icecast.mount.online / offline

worker.heartbeat

stream.smoke.passed / failed


# Anexo D. Definition of Done por tarea

Código implementado y formateado.

Tests relevantes añadidos y en verde.

Typecheck y lint en verde.

Configuración/documentación actualizada.

No hay secretos ni paths absolutos del desarrollador.

Errores esperables tienen manejo explícito.

Si toca audio, existe verificación real con Liquidsoap/Icecast, no solo mocks.

El commit deja el repositorio arrancable.


# Anexo E. Ideas para V2

Voice tracking sobre la intro de la siguiente canción usando cue-in/cue-out y ducking.

Scheduling por franjas, géneros, energía, BPM o décadas.

Múltiples personalidades/DJs por programa.

Noticias locales, agenda cultural y deporte con reglas editoriales separadas.

Dedicatorias y mensajes moderados desde panel.

Jingles dinámicos y sweepers generados.

Loudness normalization offline por catálogo.

Múltiples mountpoints MP3/Opus/AAC.

PostgreSQL y Redis si se separan procesos/nodos.

Remote storage para catálogo muy grande.

HLS como salida adicional.

Analítica de oyentes y sesiones a partir de logs de Icecast.

Integración con una web pública de la emisora.

Automatización de carátulas y metadatos enriquecidos.

Modo directo: entrada harbor para DJ humano que preemplace automatización.

Recuperación de programa tras reinicio con planificación persistente.


# Anexo F. Checklist de handoff a Codex

☐ Colocar este documento en el contexto o convertirlo a docs/SPEC_RADIO_AI.md.

☐ Entregar a Codex acceso al repositorio correcto.

☐ No proporcionar claves reales en el prompt; configurar .env local fuera del chat si procede.

☐ Confirmar que WSL2 abre Ubuntu y systemctl funciona.

☐ Tener 5-10 audios de prueba legalmente utilizables en storage/music.

☐ Tener un emergency.mp3.

☐ Permitir que Codex ejecute comandos de instalación solo cuando el entorno sea el esperado.

☐ Pedir que complete primero B01-B05 y demostrar /radio.mp3 antes de avanzar.

☐ Después continuar B06-B10, demostrando biblioteca/cola.

☐ Por último activar APIs externas y panel.

| Resultado de este documento Si Codex sigue el orden propuesto, el primer hito no será una maqueta: será una emisora local real, con audio continuo y streaming. Sobre esa base se incorporan la inteligencia, la automatización y la experiencia de administración. |

| --- |
