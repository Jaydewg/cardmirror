# Cite Check changelog

## 0.1.1

- Analytics written as tags, and empty tags, no longer get "Card has no cite". Only a tag with highlighted text under it needs a cite.
- Cites with the name and date highlighted in place (inside the full cite) now read correctly: quals, title, publication and date are no longer lost.
- A date written straight after the name ("Toby20") is read as a name and a date.
- Squiggles on in-place cites sit on the author's surname.
- URLs end at a closing bracket they didn't open, or at a backslash. Links like `…/article]\Name` (the cutter's name after the cite) are no longer reported as dead.

## 0.1.0

- First release.
