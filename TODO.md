# TODO

## overlay

- [x] periodically send overlay state (because of resizes)
- [ ] simplify rendering logic where possible without sacrificing looks
- [x] redo ui a bit to match discord more closely
- [ ] corner customization and animation toggle (also respect discords "reduce motion" setting)
- [ ] improve settings (simplify wording, add toggle)
- [x] add speaking state
- [ ] possibly(?) simplify installation
- [ ] "stupid mode" (just render a frameless window for unsupported apps. probably sdl)
- [ ] fix bug where streaming with audio counts as speaking (pfp is transparent so its probably possible cuz smthn is missing?)
- [ ] overlay customization, set corners and edges where ppl can choose to have the overlay render parts in
- [ ] emoji rendering
- [ ] custom emoji rendering
- [ ] opengl support [unium]

## tray

- [ ] mute/unmute/speaking icon
- [ ] pfp of who's speaking (works like zoom)

## general recar stuff

- [ ] simpler onboardings [WIP -ham]
- [ ] new notification engine (relying on flux dispatcher than discord's notif calls, for more control over messages)
- [ ] add overlay to settings (new tab as it is a pretty important feature), stuffs to add in overlay section
- [x] replace arRPC
- [ ] mod rebuild/update system
- [ ] easy userplugin installation (blocked by above item)
- [ ] redo settings ui to theme with discord, and template it because oh my god having everything in one html file is annoying, same for stream ui (and also replace material symbols with loxodrome icons)
- [ ] make call ui use the static fonts and remove the variable fonts, since the static fonts are needed for overlay, variable font is kinda redundant, oh and also remove inter

---

- [ ] normal semver versioning (do this when most of the above items are done!
      first normal version will be 1.2.0)
- [ ] optimize the fuck out of recar
- [ ] have everything documented in the docs by 1.2.0
- [ ] download page
