# Operación

Comprueba la emisión con `bash scripts/smoke-stream.sh`: valida el JSON de Icecast, presencia del mountpoint, respuesta HTTP y decodificación real de diez segundos. El estado del panel combina esta presencia de fuente con la conexión de comandos, base de datos y heartbeat del worker. No basta con que el proceso exista.

```bash
systemctl status icecast2 radio-liquidsoap radio-worker radio-web --no-pager
journalctl -u radio-worker -f
journalctl -u radio-liquidsoap -f
curl -fsS http://127.0.0.1:8000/status-json.xsl
bash scripts/smoke-stream.sh
```

Los logs de Icecast se encuentran en `/var/log/icecast2`; los demás servicios usan journald. Las claves viven en `.env` o `/etc/radio-ai/radio.env`; no copies su contenido en incidencias. El panel requiere el token administrativo para leer estado y ejecutar mutaciones, y nunca devuelve secretos.

## Biblioteca y continuidad

Copia música autorizada a `storage/music` y ejecuta `npm run library:scan`, o espera al scanner periódico. Se aceptan subcarpetas. El scanner escribe `storage/music-playlist.m3u` con las pistas habilitadas y válidas; Liquidsoap observa sus cambios sin reiniciar Icecast. El catálogo usa duración/metadatos y reglas de repetición. Ajusta ventanas de repetición al tamaño del catálogo. Los MP3 sintéticos iniciales tienen etiquetas explícitas de demostración.

Mantén siempre `storage/fallback/emergency.mp3` decodificable. Para probar una biblioteca vacía en un entorno de ensayo, configura otro `STORAGE_ROOT` con `music` vacío y copia solo el emergency; evita mover o borrar la biblioteca real. El health del catálogo será crítico, pero el stream debe continuar por la ruta fallback.

```bash
sudo systemctl stop radio-worker
bash scripts/smoke-stream.sh
sudo systemctl start radio-worker
```

Esta prueba confirma independencia del worker. No detengas Icecast ni Liquidsoap durante ella. `node --import tsx radio/verify-runtime.mjs` comprueba now-playing e historial autenticados y solicita una locución con una clave deliberadamente inválida en una instancia de prueba del servicio. Guarda `storage/tmp/runtime-validation.json`; la locución debe acabar FAILED, sin cola asociada, mientras una decodificación simultánea continúa. Usa el entorno privado del checkout y no altera su clave configurada.

Para probar emergencia sin tocar la biblioteca ni el mount principal, ejecuta `sudo bash radio/liquidsoap/emergency-smoke.sh`. Crea un storage de ensayo con playlist vacía y copia del emergency, levanta un segundo Liquidsoap en `127.0.0.1:1235` y `/emergency-test.mp3`, comprueba un evento real de tipo `fallback` y decodifica diez segundos. Al terminar detiene solo esa unidad temporal y conserva el informe bajo `storage/tmp/emergency-validation-*`.

## Reinicios y cambios de configuración

Tras editar `/etc/radio-ai/radio.env`, reinicia únicamente el servicio afectado. Cambiar voz o proveedor requiere worker; cambiar contraseña de fuente requiere Icecast y Liquidsoap. Reiniciar Liquidsoap implica una breve desconexión y pérdida de colas del motor; el worker conserva la cola lógica y reconcilia contenido pendiente sin repetir envíos ambiguos a ciegas. Las cuatro unidades usan `Restart=on-failure`. Icecast tiene una unidad nativa con MainPID supervisado, ejecutada como `icecast2`; worker, web y Liquidsoap usan `radio`.

```bash
sudo systemctl restart radio-worker
sudo systemctl restart radio-liquidsoap
sudo systemctl restart icecast2
```

Si `radio:check` falla, no reinicies un motor todavía funcional: corrige el script y vuelve a validar. Si el stream no aparece, inspecciona primero el emergency, permisos de storage, logs y coincidencia de contraseña fuente. Si el panel dice OFFLINE y el audio suena, comprueba heartbeat/conexión del worker antes de tocar la cadena.

## Backups y disco

La corrección de timestamps del entorno de demostración conserva el backup consistente `storage/tmp/timezone-repair-20261015T105438Z.db` y su auditoría JSON. Abarcó los 1542 eventos del boot probado `1791978821.8` con desfase exacto de una hora, recalculó sus límites con el boot UTC siguiente y los timestamps de seis pistas. `radio/repair-demo-timestamps.py` exige servicios web/worker detenidos, evidencia de ese desfase y ausencia de boots desconocidos; no es una herramienta de mantenimiento rutinario.

Haz un backup consistente de SQLite con `.backup`, además de configuración privada y música. Ajusta las rutas si cambias `STORAGE_ROOT` o `DATABASE_URL`.

```bash
mkdir -p backups
sqlite3 storage/radio.db ".backup 'backups/radio-$(date -u +%Y%m%dT%H%M%SZ).db'"
df -h .
du -sh storage/generated storage/tmp
```

Protege backups que incluyan secretos y prueba su restauración. Para restaurar SQLite detén worker y web, guarda una copia del DB actual y copia un backup verificado; Liquidsoap puede continuar. No copies un DB en uso mediante `cp`. Revisa la retención de audio generado y el espacio libre: con disco lleno el worker debe rechazar nuevas locuciones, conservar ficheros existentes y registrar el fallo.

## Prueba de estabilidad de ocho horas

La ejecución real del entorno local se inició el **15 de octubre de 2026 a las 10:56:29 UTC** (12:56 en Madrid), unidad `radio-soak-validation.service`, directorio `/home/radio/projects/radio-ai/storage/tmp/soak-20261015T105629Z-kO18Dd`. Se observó progreso de decodificación y ausencia de `finish.json` al arrancar; su aceptación queda **pendiente** hasta el resultado final, previsto aproximadamente a las 18:56 UTC. El smoke del mismo runner inmediatamente anterior acabó `SUCCEEDED`, 9.978776 segundos decodificados para un objetivo de diez.

La aceptación exige ocho horas reales. El runner usa timeout de lectura para detectar un stream detenido y comprueba código de salida, fin de progreso y duración realmente decodificada para rechazar EOF prematuro. Las pruebas negativas con una fuente finita y otra bloqueada pueden repetirse con `python3 radio/liquidsoap/soak-runner-test.py`. Un smoke de diez segundos y esas pruebas del runner no equivalen a superar ocho horas.

Arranca la prueba después de los cambios de audio, desde `/home/radio/projects/radio-ai`, con el equipo encendido y WSL activo:

```bash
sudo systemd-run --unit=radio-soak-validation --uid=radio --gid=radio \
  --property=WorkingDirectory=/home/radio/projects/radio-ai \
  /usr/bin/bash /home/radio/projects/radio-ai/scripts/soak-stream.sh 28800
systemctl status radio-soak-validation --no-pager
journalctl -u radio-soak-validation --no-pager
cat storage/tmp/soak-latest.json
python3 - <<'PY'
import json,pathlib
root=pathlib.Path(json.loads(pathlib.Path('storage/tmp/soak-latest.json').read_text())['directory'])
for name in ['start.json','finish.json']:
    if (root/name).exists():
        print((root/name).read_text())
print((root/'progress.txt').read_text()[-1000:])
PY
```

Cada ejecución conserva `start.json`, `progress.txt`, `decoder.log` y, al terminar, `finish.json` bajo `storage/tmp/soak-*`. `RUNNING` significa pendiente; solo `SUCCEEDED` con `requestedSeconds=28800` y duración decodificada próxima a 28800 satisface la aceptación. `FAILED` incluye motivo y código del decoder. El último enlace puede cambiar si se ejecuta otra prueba: conserva la ruta del registro que estás evaluando. Para repetir tras terminar, usa `sudo systemctl reset-failed radio-soak-validation` si falló y un nombre de unidad nuevo o descarga la unidad inactiva antes de recrearla.

No reinicies Icecast/Liquidsoap durante la captura. Si una reparación lo exige, conserva el resultado anterior y comienza otra captura completa. Web y worker pueden reiniciarse de forma independiente. En WSL usa `scripts/start-wsl.ps1` desde Windows para mantener una sesión oculta; liberar ese proceso, la suspensión, el apagado o detener WSL puede interrumpir la emisora. Para 24/7 usa el VPS Ubuntu descrito en `DEPLOY_UBUNTU.md`. Una clave OpenAI válida y cuotas disponibles son necesarias para aceptar generación externa real; la continuidad musical funciona sin ellas.
