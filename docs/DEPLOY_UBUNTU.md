# Despliegue en Ubuntu

Usa Ubuntu 24.04 LTS y un usuario de servicio `radio`. El mismo bootstrap, repositorio, schema y motor de audio sirven en WSL y VPS; solo cambian secretos, URL pública, permisos y exposición de red.

```bash
sudo useradd --create-home --home-dir /home/radio --shell /bin/bash radio
sudo -u radio mkdir -p /home/radio/projects
sudo -u radio git clone <URL_DEL_REPOSITORIO> /home/radio/projects/radio-ai
cd /home/radio/projects/radio-ai
bash scripts/bootstrap-wsl.sh
npm ci --include=dev
npm run db:generate
npm run db:migrate
npm run library:scan
npm run build
npm run radio:check
bash scripts/install-services.sh
bash scripts/smoke-stream.sh
```

Omite `useradd` si el usuario ya existe. Ejecuta los comandos npm como `radio`, o con `sudo -u radio`, para conservar su propiedad. El instalador valida usuario no root, ejecución de Node/npm por ese usuario, build de producción y emergency, configura permisos de storage y `.next`, copia el entorno a `/etc/radio-ai/radio.env` con permisos 0640 y habilita worker, web, Liquidsoap e Icecast. La copia privada fija `NODE_ENV=production` y rutas absolutas sin alterar el `.env` del checkout. El checkout debe ser legible por radio y sus padres deben permitir atravesar la ruta. No se cambian recursivamente los permisos de la carpeta personal de otro usuario.

El instalador sustituye la unidad heredada SysV de Icecast por una unidad nativa que ejecuta `/usr/bin/icecast2` como `icecast2:icecast` y supervisa su PID real con reinicio ante fallo. Las otras tres unidades usan `radio`. Los helpers `start-wsl.ps1` y `stop-wsl.ps1` son exclusivos de Windows; un servidor Ubuntu mantiene sus servicios directamente con systemd.

En `.env`, configura modelos/proveedores, token administrativo largo, contraseñas de Icecast independientes, `STREAM_PUBLIC_URL=https://radio.example.com/radio.mp3` y `ADMIN_ORIGIN=https://radio.example.com`. El panel debe informar claramente de que la voz del DJ se genera por IA. No publiques música sin autorización. Reemplaza los tonos de prueba cuando prepares el catálogo real.

## Proxy TLS

Mantén Next en `127.0.0.1:3000`, Icecast en `127.0.0.1:8000` y comandos Liquidsoap en localhost. Expón únicamente HTTPS mediante tu proxy. Un bloque Nginx orientativo, dentro de un servidor TLS ya configurado:

```nginx
location = /radio.mp3 {
    proxy_pass http://127.0.0.1:8000/radio.mp3;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 1h;
    proxy_set_header Host $host;
}
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Obtén certificados válidos y verifica el proxy con un stream prolongado, sin buffering. Protege el panel con autenticación del reverse proxy o una red privada además del token que protege las lecturas de estado y acciones administrativas. No publiques `/admin` de Icecast ni su servidor de comandos. Antes de activar un firewall, conserva el acceso SSH del proveedor; permite SSH y HTTPS y cierra 1234, 3000 y 8000 externamente.

## Actualizaciones y recuperación

Haz backup consistente de DB, configuración y catálogo. Instala dependencias con `npm ci`, aplica migraciones, crea build, valida Liquidsoap y reinicia los servicios afectados. El cambio a otra versión de Liquidsoap es una operación explícita: comprueba soporte de la distribución, prueba colas/eventos y decode real antes de cambiar producción. El canal estable 2.4.6 está fijado por el bootstrap para Noble; no instala un release candidate de otra distribución.

Añade monitorización externa del mountpoint, alertas de disco, rotación de logs y una prueba periódica de restauración. SQLite sigue siendo válido para un solo nodo; migra a PostgreSQL cuando la carga o arquitectura lo exijan, manteniendo al motor independiente de la base de datos.

La prueba de ocho horas en `OPERATIONS.md` sigue pendiente hasta ejecutarla realmente en el servidor de destino.
