# Actualización del perfil

El README consulta la API de GitHub cada día a las 07:17 UTC. La animación consulta el mismo calendario a las 07:47 UTC. GitHub puede retrasar las ejecuciones programadas. El workflow procesa los datos cuando arranca, sin exigir que coincida el minuto previsto.

Se puede actualizar desde Actions → Update profile README → Run workflow. Generate snake actualiza la animación. Ambos workflows comparten un grupo de concurrencia para evitar escrituras simultáneas.

## Datos y privacidad

El total procede de `contributionsCollection` y abarca los últimos 365 días. Incluye las contribuciones privadas que GitHub permite ver al token. `restrictedContributionsCount` identifica actividad privada sin desglose y ya forma parte del total. No se suma de nuevo ni se presenta como un número de commits.

GitHub aplica sus propias reglas de atribución. Los commits deben estar vinculados al usuario y cumplir las condiciones del calendario, como pertenecer a la rama predeterminada o a `gh-pages`. La búsqueda de commits también depende de la indexación de GitHub. Estas cifras no cuentan necesariamente todos los commits de todas las ramas ni todo el historial de la cuenta.

Las listas de repositorios, commits y PRs solo publican detalles de repositorios confirmados como públicos. La actividad privada se refleja mediante contadores y bytes de lenguajes agregados. No se publican nombres, descripciones, enlaces o mensajes privados.

Los lenguajes representan bytes de código de los repositorios consultados, no líneas escritas por una persona. Se descubren repositorios propios, repositorios con actividad pública reciente y, cuando hay un token personal, repositorios accesibles como propietario, colaborador o miembro de una organización. Tener acceso no demuestra haber contribuido a todo su código.

Se consultan todos los repositorios detectados, incluidos archivados y forks. Estos últimos pueden repetir código de su origen. Si se supera el presupuesto de 500 repositorios, la generación falla en vez de publicar una muestra como si fuera el total. Se excluyen los lenguajes configurados en `EXCLUDED_LANGUAGES`, cuyo valor inicial es `Hack`. Las búsquedas consultan hasta tres páginas de 100 resultados por tipo de actividad. Si hay más resultados, el README indica el límite. Las listas públicas muestran los cinco resultados más recientes y omiten el propio repositorio del perfil.

## Acceso a repositorios privados

Sin configuración adicional se usa `GITHUB_TOKEN`. Permite consultar información pública y las contribuciones privadas anonimizadas que el usuario haya hecho visibles en Contribution settings → Private contributions.

Para consultar repositorios privados, se configura una sola vez el secreto `PROFILE_GITHUB_TOKEN` en Settings → Secrets and variables → Actions de este repositorio. No hay que añadir workflows ni secretos en los demás repositorios.

Un token clásico con `repo` y `read:user` puede consultar los repositorios privados accesibles a su propietario. El permiso `repo` también concede escritura, aunque este generador solo realiza consultas. Un token de permisos detallados reduce el acceso, pero su alcance depende del propietario y de los repositorios seleccionados. Las organizaciones pueden exigir aprobación, autorización SSO o impedir determinados tipos de token. Ningún token evita esas restricciones.

El token personal debe pertenecer al usuario del perfil. Su caducidad se gestiona en GitHub. Si caduca o la API falla, la ejecución debe fallar y conservar el README anterior. La falta de un token personal permite seguir actualizando los datos públicos y las contribuciones anonimizadas. Para publicar los archivos se utiliza el token automático de Actions, separado del token de consulta.

## Comprobaciones locales

Se necesita Node 24. Las dependencias de desarrollo están fijadas en `package-lock.json`.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:coverage
npm run build
```

La generación requiere `GITHUB_TOKEN`, `GH_TOKEN` o `PROFILE_GITHUB_TOKEN` en el entorno. Las pruebas usan respuestas simuladas y no necesitan credenciales. Incluyen regresiones de actualización sin token personal, protección de datos privados, paginación, errores HTTP y errores GraphQL. La cobertura utiliza la instrumentación V8 del ejecutor de pruebas de Node.

Cada petición tiene un timeout de 20 segundos. Los errores transitorios admiten hasta tres intentos, con esperas de un máximo de 30 segundos. No se reintenta un rechazo de permisos como si fuera una limitación temporal. Las consultas de repositorios se limitan a 1000 elementos y fallan si se alcanza ese límite sin confirmar el final. Los workflows tienen un tiempo máximo de ejecución y publican un resumen de los datos consultados.

## Referencias

- [Programación de workflows y posibles retrasos](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
- [Reglas de las contribuciones del perfil](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference).
- [Visibilidad de contribuciones privadas](https://docs.github.com/en/account-and-profile/how-tos/contribution-settings/manage-visibility-settings-for-private-contributions-and-achievements).
- [Autorización de tokens mediante SSO](https://docs.github.com/en/enterprise-cloud%40latest/authentication/authenticating-with-single-sign-on/authorizing-a-personal-access-token-for-use-with-single-sign-on).
