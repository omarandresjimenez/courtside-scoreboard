# Umpire screen — court-view redesign spec

Requirements captured from a screen recording of an official-style badminton
umpire app (`umpiresampledoubles.gif`, a doubles match, 3 games of 15 points).
Reference frames extracted from that recording live in
[`reference/umpire-app/`](reference/umpire-app/) and are cited by number below.

The goal is to reproduce that app's _interaction model_ — a visual court the
umpire reads and manipulates — while keeping this project's existing dark
theme and its Side A / Side B colour language.

## Why this shape

An umpire is not entering data, they are **calling a match out loud**. The
screen has to answer, at a glance and between rallies:

- who is serving, and **from which service court**
- who is receiving (the diagonal opposite)
- what the umpire must say next, word for word

A vertical stack of score buttons cannot answer the middle two at all. A court
diagram answers all three at once, which is why the reference app is built
around one.

## Screens

### 1. Setup / warm-up — frame 01

- A warm-up countdown (`00:05` in the recording) with a **Start Match** button.
- The court diagram, already populated with all four players.
- **⬆⬇ arrows on each half** swap that pair's two players between the near and
  far service courts.
- **◀▶ arrow at the net** swaps which team occupies which end.
- **Left serve / Right Serve** radio selects the serving end.
- The serving team's half is tinted.

The umpire arranges the physical reality of the court here, then starts.

### 2. Scoring — frames 02–06

Layout, top to bottom:

| Region | Contents                                                           |
| ------ | ------------------------------------------------------------------ |
| Header | Both team names, one per row, with their game scores right-aligned |
| Court  | The diagram; **the server's service court is filled solid orange** |
| Sides  | A tall `+1` button on the far left and far right, one per team     |
| Footer | The umpire's call (left) and **Undo** + announce (right)           |

Only the **server's** box is highlighted — the receiver is left implicit,
since it is always the diagonal box. Player names sit inside their current
service courts and move as the score changes.

### 3. Match end — frame 08

`Match won by <team>`, a per-game score table, and **Finish / Undo / Share /
Stats**.

## The call label — the heart of it

Bottom-left, always showing exactly what the umpire says. Forms observed:

| Situation               | Call                                          | Frame |
| ----------------------- | --------------------------------------------- | ----- |
| Server leads / trails   | `5, 4` — **server's score first, always**     | 04    |
| Scores level            | `2 all`                                       | 03    |
| Opponent on zero        | `1, love`                                     | 02    |
| Serve changed hands     | `Service over, 1, love`                       | 06    |
| Interval (score cap/2)  | `8, love. Interval`                           | 07    |
| One point from the game | `14 game point 4`                             | 05    |
| Match over              | `Match won by Angel Hortua / Adriana Naranjo` | 08    |

Rules this implies:

- The **server's score is spoken first**, not Side A's. The label is
  serve-relative, unlike the scoreboard which is side-relative.
- `love` replaces zero.
- `<n> all` replaces `<n>, <n>`.
- `Service over` prefixes the call on any rally where the serve changed side.
- Game point / match point is announced when a side is one point from winning.
- The interval call is suffixed, not prefixed.

A **Confirm Game Resume — Are you sure?** dialog guards leaving the interval
(frame 07).

## Ends change between games

Frames 03 and 06 are the same match, different games: the two teams have
swapped which end of the court they occupy. Ends alternate each game. This is
presentation only — Side A stays Side A in the data.

## What our domain model already provides

Most of this is already implemented in `packages/shared/src/scoring.ts` and
does **not** need rebuilding:

- `CourtPositions` — `{ A: { right, left }, B: { right, left } }`, the exact
  data the diagram needs to place names in boxes.
- `ServeState` — `{ servingSide, serverPlayerId, courtPositions }`.
- The BWF doubles rotation: partners swap service courts **only** when their
  side wins a point while already serving, so parity of the serving side's
  score selects right vs. left court.
- `START_SET` already carries `firstServerSide`, `firstServerPlayerId` and
  `courtPositions`, and is wired client → socket → replay.
- Interval detection, set winners, match winner, undo via event replay.

## What has to be built

1. **`umpireCall()`** — a new pure function in `packages/shared`, taking the
   derived state plus whether the serve just changed, returning the call
   string. Pure and table-testable; belongs beside `deriveMatchState`.
2. **Service-over detection** — compare `servingSide` before and after the
   last point during replay, or expose it from `deriveMatchState`.
3. **Court diagram component** — SVG or CSS grid, singles (2 boxes) and
   doubles (4 boxes), names placed from `courtPositions`, server's box filled.
4. **Setup screen rework** — replace the current `<select>`-based form with
   the diagram plus swap controls, emitting the same `START_SET` payload.
5. **Ends alternation** — a presentation-level `leftSide` derived from the
   game number.
6. **Game-point / match-point detection** — from score vs. `pointsToWin` and
   `capScore`.

## Deliberately out of scope for the first pass

`Share`, `Stats`, the warm-up countdown timer, and team/country entry — none
are needed to score a match, and each is a feature in its own right.
