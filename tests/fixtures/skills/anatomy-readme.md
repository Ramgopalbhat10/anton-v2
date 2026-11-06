<h1 align="center">Anatomy</h1>
<p align="center"><b>A skill that explains an idea by building it as a real, working object.</b><br>Also runs in Antigravity, OpenCode, Codex and MiniMax Code.</p>
<p align="center"><a href="https://code.claude.com/docs/en/skills">![Claude Code skill](https://img.shields.io/badge/Claude_Code-skill-blue)</a> <a href="#requirements">[Node 20.10 or later](#requirements)</a></p>

## Quick start

Build **precise figures** with `SVG` and Markdown.

<div align="center">

### A real instrument

- Four-tone shading
- Many small parts

</div>

<details><summary>Requirements</summary>

Node 20.10+ and **Chromium**.

</details>

<p><img src="assets/rig.png" alt="Test rig" onerror="window.skillExecuted = true"></p>

```html
<img src="example.png" onerror="alert('example only')">
```

<script>window.skillExecuted = true</script>
<style>body { display: none }</style>
<iframe srcdoc="<script>window.skillExecuted = true</script>"></iframe>
<svg onload="window.skillExecuted = true"><a href="javascript:alert(1)">Bad SVG</a></svg>
<p onclick="window.skillExecuted = true" style="position:fixed;inset:0">Safe text <a href="javascript:alert(1)">Unsafe link</a></p>
<a href="data:text/html,<script>alert(1)</script>">Unsafe data</a>
