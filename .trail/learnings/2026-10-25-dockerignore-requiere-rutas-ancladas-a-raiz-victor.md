---
title: Dockerignore requiere rutas ancladas a raiz para no excluir src/services/reports
author: Victor
date: 2026-10-25
branch: main
id: l-bc705a22
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - Dockerfile
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
---

## Decided
- Las entradas en .dockerignore deben anclarse a la raíz con barra inicial (ej. /reports, /coverage, /docs) en vez de nombres relativos libres.
- Fijar el runtime a Node.js >= 24.22.1 en Dockerfile y package.json engines para mitigar CVE-2026-111497 (Node2Shell) y evasión de validación TLS.
- En pnpm v12, habilitar allowBuilds: esbuild: true en pnpm-workspace.yaml y copiar dicho archivo en el Dockerfile.

## Tried and ruled out
- Patrones sin barra en .dockerignore como "reports": Docker excluye cualquier subcarpeta que coincida con el nombre, lo cual eliminó src/services/reports/ y provocó error TS2307 en Cloud Build.
- Omitir pnpm-workspace.yaml en Dockerfile: pnpm v12 falla la instalación con ERR_PNPM_IGNORED_BUILDS si no encuentra el workspace con los builds aprobados.

## Watch out
- Al agregar carpetas a .dockerignore o .gcloudignore, siempre anteponer "/" si se trata de directorios en la raíz del proyecto para proteger subdirectorios de código fuente.
