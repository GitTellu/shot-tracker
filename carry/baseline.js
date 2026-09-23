/* Carry: the strokes-gained baseline.
   Expected strokes to hole out, by lie and distance, from a published source. Strokes gained for
   a shot is E(start) - E(finish) - 1, so every SG number in the app is only as good as this table.

   Format (distances ascending; the app interpolates linearly between rows and clamps at the ends):
     window.CARRY_BASELINE = {
       source: 'Who published it, which players and years',   // shown on the Stats screen
       label: 'PGA Tour',                                       // what "SG vs ..." reads
       tee:      [[yards, strokes], ...],
       fairway:  [[yards, strokes], ...],
       rough:    [[yards, strokes], ...],
       sand:     [[yards, strokes], ...],
       recovery: [[yards, strokes], ...],
       green:    [[feet,  strokes], ...]
     };

   Left empty on purpose: the numbers must come from the source, not from memory. Until it is
   filled in, Carry records every shot as normal and shows strokes gained as not available;
   the rounds already played are scored as soon as a table is added. */
window.CARRY_BASELINE = null;
