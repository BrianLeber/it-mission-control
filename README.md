# it-mission-control

A quick-look IT status board. It shows the current state of public SaaS, our own platforms
(Jamf, NinjaOne, Front) and internal infrastructure, with peak-hold status borders and a
compressed-time history. Every card links straight to the source.

- **Design:** [`docs/DESIGN.md`](docs/DESIGN.md) covers states, the history strip, views,
  architecture, the email and classifier pipeline, the roadmap and open questions.
- **Prototype:** open [`prototype/index.html`](prototype/index.html) in a browser. It
  needs no build step and uses simulated data with a scripted demo feed. Keys `1` `2` `3`
  switch between Cards, List and Board; `F` goes fullscreen on the board. Append
  `#board` to the URL to open straight into the TV view.
