# Federation Decisions
*for anyone who decides to maintain this nightmare* 
Decisions made about federation are located here, to not clog up the main documentation file (which is a fight between my voice and Claude insisting that it sounds unprofessional).

## Goals
From greatest to least (yes I do the bold first sentence thingy that AI does):
1. **Backwards compatibility.** It's like USB-A superspeed: New client, new server -> new and exciting capabilities. BUT old client, new server or new client, old server should retain the base capabilities.
2. **Simple systems.** Debaters aren't the group that gets scammed. The unauthenticated attack surface is very small: without any knowledge of how the server works, `RELAY_TOKEN` rejects the request already. A slightly knowledgeable actor may be able to jam someone's mailbox -- but a Clear button already exists, and IPs can be banned, debaters can be kicked off the team, etc. And there's an authentication prompt for coediting, with read-only.
3. **Extensible systems.** Because the attack surface is small and the possibilities are large, the system is failsafe. Extra metadata tags are ignored, not something for the system to panic over.

## Addresses & Naming Systems
Backwards compatibility is really the main reason. Because this is at the mercy of a upstream right now, federation identifiers are kept seperate (eg. cmk1f, cmshare2f). This allows for upstream version increments (like cmk2 or cmshare3) without causing massive problems with lettering.

The way to name relays is their URL. This is standard in so many systems, including Matrix, email, etc. The question is whether a short name should be allowed. The conclusion was that the short nickname would be used as an indicator but not an identifier. Why:
- Nicknames can be spoofed. Easily.
- They need to be registered first. Without any underlying infrastructure, you'd need to use the URL first, making everything more complicated. It's just easier to use URL's 
- BUT a full URL, especially with hosting services that debaters might use, will probably be very long -- and not very insightful. Allowing a custom nickname means that names are infinitely more descriptive and useful.

## Transmission
There's a small handshake. This ensures that a relay isn't sending ghost packets and can instantly reject a bad URL.
In addition, there's also /relay/capabilities. Fun fact: this actually predates the NSP (New Server Project, which is still the local name on my computer.) This transmits data about endpoints, federation capabilities, max room capacity.

## Trust
Relay encryption handles most things. The relay can never really see the independent contents of the edits you send, so the question is between clients.
Should 

## Deadlock Scenarios
There's some problems here. For example:
- **Only old clients are linked to the local server, while a new client from a remote server is attempting to federate into the local server.** In this case, no one can approve the request. This is fixed by two things: an ACK when a new client recieves the request, and another ACK when the user sees / opens it. If no client sends a recieved ACK, it's assumed that no one can actually accept, meaning that 
- **The host leaves and never comes back, leaving the session open.** This is a trust issue here. Should only the server admin get a say? Anyone on the local server? Anyone with a share code? In the end this falls back to the trust paradigm for coediting:

## UI
The bottom panel has turned from a nice to have to a nessecity. Here's why enhancements came:
- **Increasing complexity.** The panel now has to show read-only, people from remote sessions, queued updates, etc. Arguably the enhanced icons are overdue -- ongoing status change through a tooltip/temporary toast is not a great model and hides data for most users.
- **Trust management.** Now with having to be able to instantly end session for all, upgrade access from or to read-only, or just kick a remote joiner off of the doc, the panel is the place to do that without needless right-clicks (which mind you are still in contention on Macs sometimes)

(I'm improving that UI after St. Marks is over. I'll get to polishing this before something like Apple Valley.)



# AI Use here
AI usage is certainly documented here. Here's where it got used:
- **Making tests and Github Actions.** Github Action files are wildly out my expertise right now.
- **Neutral Documentation.** AI has been used to write some parts 
- **Library Comprehension.** A side product of having this from upstream is that I didn't know what 20 seperate .ts scripts did.
- **Quick and dirty features.** As software used by a very feature-hungry debate team, I'm unfortunately responsible for implementing features (and sometimes within short notice (!)). Some of this stuff was quickly iterated upon using generative tools, though the logic is always user-prompted. (AI *sucks* at UI and some placement.)