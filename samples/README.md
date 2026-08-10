# Sample payloads

Real `statusschedule.php` responses, kept because Hunter's API documentation
does not describe what the fields mean in each state, and this behaviour was
worked out by observation.

## `status-running.json`

Four consecutive polls during a manually triggered `runall` of four zones at
120 seconds each, captured roughly 100 seconds apart. Each poll catches a
different zone mid-run, so together they show a zone moving through queued →
running → finished.

The key finding is that **`run` means different things depending on state**:

| State | `time` | `timestr` | `run` | `type` |
| --- | --- | --- | --- | --- |
| Running now | `1` | `"Now"` | **seconds remaining** | `106` here |
| Queued | seconds until start | clock time | full duration of the upcoming run | `106` here |
| Idle | seconds to next scheduled run | day name | duration of the next run | `9` |

The arithmetic is self-consistent across all four samples — a running zone's
`time + run` equals the next zone's `time`, because zones run back to back:

```
sample 1: zone 1 time=1 run=79  → zone 2 time=80   (1 + 79)
sample 2: zone 2 time=1 run=99  → zone 3 time=100  (1 + 99)
sample 3: zone 3 time=1 run=110 → zone 4 time=111  (1 + 110)
sample 4: zone 4 time=1 run=115 → last zone
```

Queued zones chain the same way: `80 → 200 → 320`, each being the previous
zone's `time + run`.

Note there is **no `running` array** in the payload. Some third-party
integrations assume one; this controller does not send it.

## `status-scheduled.json`

Two polls during a *scheduled* program on a controller using seasonal
adjustment and cycle-and-soak, taken at 08:01:00 and 08:11:06 local time — ten
minutes apart, either side of the first zone change.

This is the sample that settles what `type` actually means. A scheduled run
reports **`type: 9`**, for the running zone *and* the queued ones — the same
value an idle zone reports. So `type: 106` marks a manually triggered `runall`
queue, not "running", and **`type` says nothing about whether water is on**:

| | Running | Queued | Idle |
| --- | --- | --- | --- |
| Manual `runall` | `106` | `106` | — |
| Scheduled program | `9` | `9` | `9` |

What separates the three states is `time`/`timestr`, in both modes: `1` /
`"Now"` while running, a small countdown and a clock time while queued, a large
countdown and a day name while idle.

The back-to-back arithmetic holds for scheduled runs too:

```
poll 1 (08:01:00)                      poll 2 (08:11:06)
zone 1 time=1    run=539 → 540         zone 2 time=1    run=533 → 534
zone 2 time=540  run=600 → 1140        zone 3 time=534  run=540 → 1074
zone 3 time=1140 run=540 → 1680        zone 4 time=1074 run=780 → 1854
                                       zone 1 time=1854  ← comes back round
```

Zone 1's `run: 539` in poll 1 is seconds remaining out of a 540-second burst,
consistent with a cycle that had just started.

### Cycle-and-soak, and what the payload hides

This controller waters on an incline, so its program uses **cycle-and-soak**:
each zone's total time is split into shorter bursts that let water soak in
rather than run off. **Seasonal adjustment** is on too, scaling durations
through the year.

Poll 2 shows how that surfaces. Zone 1 has finished a 540-second burst and now
reports `timestr: "08:42"` with `run: 480` — a second, shorter burst queued for
later in the same cycle, right after zone 4. It is indistinguishable in shape
from any other queued zone, which is correct: it *is* queued.

Two things follow, and they cut in opposite directions:

- **The chain survives.** It runs `zone 2 → 3 → 4 → 1` with no gap at all: the
  soak time for zone 1 is filled by the other zones running, not by the
  controller sitting idle. Something is watering for the whole cycle, and no
  multi-zone program observed here has ever left dead air. A program containing
  a *single* zone might behave differently — with nothing to fill the soak, the
  controller would have to wait, and every `time` would read greater than 1
  mid-cycle. That is a guess: it has never been tested.
- **The list understates the cycle.** Each `relay_id` appears exactly once, so a
  zone only ever advertises its *next* burst, and a running zone advertises none
  at all. Poll 1 gives no hint that zone 1 is due again at 08:42 — that burst
  only appears once zone 1 stops. Summing `run` across `relays[]` therefore does
  not give the length of the watering cycle, and a zone's `run` is one burst,
  not its total for the day.

Seasonal adjustment shows up in the same data: zone 1 reports `600` in
`status-running.json` and bursts of `540` then `480` here.
