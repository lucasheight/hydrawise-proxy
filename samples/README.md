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

| State | `type` | `time` | `timestr` | `run` |
| --- | --- | --- | --- | --- |
| Running now | `106` | `1` | `"Now"` | **seconds remaining** |
| Queued | `106` | seconds until start | clock time | full duration of the upcoming run |
| Idle | `9` | seconds to next scheduled run | day name | programmed duration |

The arithmetic is self-consistent across all four samples — a running zone's
`time + run` equals the next zone's `time`, because zones run strictly back to
back:

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

### Caveat

Every sample here comes from a *manual* `runall`. Whether a zone running as
part of a *scheduled* program also reports `type: 106` is unverified. Anything
detecting "is irrigation running" should be checked against a scheduled cycle
before being trusted, since scheduled runs are the common case.
