# Estado de verificación

Este documento se actualiza con resultados ejecutados. No confundir implementación con una prueba de emisión completa.

## Verificado

- Ubuntu 24.04.5 LTS, systemd como PID 1; Node 24.21.0, npm 11.19.0, Liquidsoap 2.4.6, Icecast 2.4.4 y FFmpeg 6.1.1 instalados en WSL.
- `liquidsoap --check` real, ejecutado como usuario no privilegiado `radio`: aprobado.
- Stream MP3 real: HTTP GET, presencia del mountpoint, decodificación de diez segundos y protocolo nativo de colas/metadatos/eventos: aprobados.
- Icecast, Liquidsoap, worker y web instalados con systemd; los cuatro servicios observados activos el 15 de octubre de 2026.
- `npm run test`: 63 pruebas aprobadas el 15 de octubre; SQLite real temporal, protocolo TCP/HTTP, SDK de OpenAI simulado, horarios DST, recuperación, cancelaciones concurrentes y rutas seguras.
- `npm run lint` y `npm run typecheck`: aprobados el 15 de octubre.
- Build de producción Next.js 16.4.0: aprobado en Windows y Ubuntu. Se excluyen secretos y audio del trazado de despliegue.
- Playwright: doce casos de escritorio/móvil aprobados el 15 de octubre, incluidos fallos parciales de API, respuestas antiguas de navegación/búsqueda y una mutación que termina después de cambiar de sección.
- Migración Prisma 6.19 aplicada y repetición idempotente aprobadas. Se acota `RUST_LOG=info` al subproceso de migración para evitar un fallo del parser de Prisma con el nivel heredado `warn`.
- Consulta meteorológica real Open-Meteo: verificada para Donostia.
- Revisión independiente: corregidos y comprobados los cruces entre cancelación, reproducción y reconciliación, y la actualización de datos tras una mutación y navegación concurrentes. Revisión visual final aprobada en escritorio de 1440 px y móvil de 390 px, con capturas de datos reales, sin desbordamiento visible.
- Caída del worker: decodificación real de diez segundos aprobada con el worker detenido y posterior arranque correcto.
- Clave OpenAI deliberadamente inválida: intervención FAILED con error OPENAI_AUTH y cero elementos en cola; la decodificación simultánea de diez segundos continuó.
- Fallback aislado: segundo Liquidsoap con biblioteca vacía, evento real de tipo fallback y diez segundos decodificados, sin modificar la biblioteca principal.
- Runner de estabilidad: pruebas negativas de EOF prematuro y stream bloqueado aprobadas; ambas se rechazan como fallos.
- Fechas de reproducción: Liquidsoap emite instantes UTC explícitos, comprobados frente al reloj real. Se repararon 1542 eventos de demostración con un desfase demostrado de una hora, conservando copia SQLite consistente e informe `storage/tmp/timezone-repair-20261015T105438Z.json`. La validación posterior no detecta historial ni últimas reproducciones en el futuro.

## Configuración y aceptación pendientes

- OpenAI real requiere `OPENAI_API_KEY` en el entorno privado de WSL. Los tests no consumen créditos y no acreditan una llamada con credenciales reales.
- Los RSS no tienen fuentes iniciales impuestas; se configuran desde Fuentes o `NEWS_SOURCES_JSON`. Su ausencia se refleja como estado degradado y no detiene el audio.
- Estabilidad de ocho horas: omitida por instrucción expresa del usuario el 15 de octubre de 2026. La captura iniciada a las 10:56:29 UTC se detuvo; sus registros se conservan bajo `storage/tmp/soak-20261015T105629Z-kO18Dd`. No se acredita una prueba larga. El runner `scripts/soak-stream.sh` y sus instrucciones siguen disponibles para ejecutarla en el futuro.
- Los audios iniciales son tonos sintetizados etiquetados como demostración. El catálogo musical definitivo lo aporta el operador.

Los primeros intentos de instalación se interrumpieron por falta de espacio. El código y los secretos se conservaron y se reanudó la validación tras liberar espacio; no se borraron datos personales.
