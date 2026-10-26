/**
 * Spectate invites: a `cmview1.` code classifies as a room invite (so the
 * Receive pill renders a Watch row), and its envelope floor is the
 * spectator-capable version, so older clients drop it with the update
 * toast instead of a Join they cannot honor.
 */
import { describe, expect, it } from 'vitest';
import { buildRoomInviteItem, parseRoomInvite, roomInviteFloor } from '../../src/editor/pairing/room-invite.js';
import { MOVABLE_ROOMS_MIN_VERSION, SPECTATOR_MIN_VERSION } from '../../src/editor/relay-protocol.js';

describe('room invites: spectate', () => {
  it('a view code parses as an invite; junk prefixes do not', () => {
    const item = buildRoomInviteItem({ shareCode: 'cmview1.abc.key.1.0.0', title: 'Aff' });
    expect(parseRoomInvite(item)).toEqual({ shareCode: 'cmview1.abc.key.1.0.0', title: 'Aff' });
    expect(parseRoomInvite({ type: item.type, sliceJson: { shareCode: 'cmnope.abc', title: '' } })).toBeNull();
  });

  it('the spectate floor is the spectator-capable version, regardless of room format', () => {
    expect(roomInviteFloor('movable', 'view')).toBe(SPECTATOR_MIN_VERSION);
    expect(roomInviteFloor('list', 'view')).toBe(SPECTATOR_MIN_VERSION);
    expect(roomInviteFloor('movable')).toBe(MOVABLE_ROOMS_MIN_VERSION);
  });
});
