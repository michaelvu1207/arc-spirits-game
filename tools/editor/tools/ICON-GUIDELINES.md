# Arc Spirits icon guidelines

Approved by Michael on 2026-11-11 after three rounds. The Paladin icon (a sword with one flame, in front of a shield) is the reference: "absolutely perfect".

## The rule
The class name, the icon and the spirit art must match. Take the subject from what the class is and from the artwork of the spirit that has the class (its main prop, weapon or shape). Know what the class means in the game before you draw it (example: a Cultivator is a person who upgrades the Guardian's power, not a plant).

## The look
- Flat, one color (#413c3b), transparent background. The hexes tint it white.
- One strong silhouette made of a few large solid shapes. It must read at 32 px.
- One subject, close-up, it fills the frame. At most one small effect (one flame, one snowflake, one sparkle).
- A few thick negative-space cuts for the most important inner details. "Detailed enough", not detailed.
- For a character class, prefer the weapon or the key object over the face or the full figure (Hunter = bow, arrow, one snowflake; Wildling = two crossed swords, two leaves). For an animal, only the head (Ram = ram head with two horns).

## Do not
- Do not draw plain geometric symbols by hand (the hand-made SVG set was rejected: too simple, out of context, "four cubes" for Elementalist meant nothing).
- Do not make ornate emblems: no filigree, no swirls around the subject, no borders, no scattered dots, no wings and halos as decoration (the first generated set was rejected as "way too detailed").
- Do not put two or three ideas in one icon (lotus + beads + mountain was too much for Monk).
- Do not replace an icon in use without approval. Put the proposal in `references/icons/classes_new/<Class>.png`; the Classes tab of the Data page shows it next to the current icon with a "new" label.

## How to make one
`python3 tools/make_icon.py "<Class>" "only <one subject>, nothing else" --art "<workspace path of the spirit art>"`
- Write the subject as "only X, nothing else", and name what must not be there ("no person", "no face").
- Run one at a time and look at the result. Runs in parallel can copy the wrong image.
- If the tool hangs, the image is usually in `~/.codex/generated_images/`; the script takes it from there.

## After approval
Copy the current icon to `references/icons/classes_old/<Class> (icon).png` (only if it is not there yet), copy the proposal to `references/icons/classes/<Class> (icon).png`, and move the proposal to `references/icons/classes_approved/`. The hexes draw again on the next load of the Hex spirits tab.
