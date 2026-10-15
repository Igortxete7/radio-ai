---
name: Radio AI
description: Control de emisión de una emisora musical automatizada
colors:
  accent: '#166443'
  canvas: '#f6f7f8'
  surface: '#ffffff'
  ink: '#17201c'
  muted: '#53615b'
  line: '#dce3df'
  danger: '#a52a2a'
typography:
  heading:
    fontFamily: 'Geist Sans, sans-serif'
    fontSize: '30px'
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: '-0.025em'
  body:
    fontFamily: 'Geist Sans, sans-serif'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.5
rounded:
  control: '8px'
  player: '14px'
spacing:
  control-gap: '8px'
  main: '36px'
components:
  button-primary:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.surface}'
    rounded: '{rounded.control}'
    padding: '8px 13px'
    height: '38px'
---

# Design System: Radio AI

## Overview

Follow the supplied light Geist/shadcn operational brief. Audio, observed state and contextual actions lead each screen.

## Colors

Canvas, surface, ink, muted, line, accent and danger match the CSS variables in apps/web/app/globals.css. Color reports status alongside text; it never carries state alone.

## Typography

Geist Sans is self-hosted from the installed geist package. Body 14px/1.5; main heading 30px/1.2; section heading 18px/1.3. Tabular numbers for times and durations.

## Layout

Desktop sidebar 220px, main content max 1240px with 36px padding. At widths below 780px navigation becomes a horizontally scrolling bar and content uses 18px padding. Tables scroll within their region rather than the entire viewport. Use clear horizontal sections; reserve bordered surfaces for the player and focused forms.

## Elevation & Depth

Operational regions use borders and flat surfaces. Only the protected confirmation dialog has an offset soft shadow.

## Shapes

Controls have modest 8px rounding; the main player uses 14px. Pills are reserved for compact status labels.

## Components

Controls 38px minimum height; consistent Lucide stroke icons. Focus visible with 2px accent outline; disabled/loading/error states explicit. All feedback appears inline with aria-live. Destructive broadcast skip/remove actions require Radix accessible confirmation.

## Do's and Don'ts

Preserve tables, timelines, explicit degraded states and useful empty states. Avoid autoplay, decorative waveforms, analytics, invented audience figures and hiding backend faults behind reassuring status.
