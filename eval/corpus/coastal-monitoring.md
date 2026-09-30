# Coastal Monitoring Programme

## Overview

Coastal monitoring tracks a tidally driven water body at the land margin. Its distinguishing
problem is that the water body moves twice a day: a station is never at the same depth for
two consecutive visits, and a tidal phase that happens to coincide with a sampling run can
dominate the reading.

The programme covers four shore stations and two offshore buoys. Shore stations are visited;
buoys are instrumented and telemeter. The two kinds of station are reported separately,
because mixing a telemetered series with a visited series is the most common defect in a
coastal dataset.

## Sampling Interval

Routine sampling runs **hourly** at the telemetered buoys and **fortnightly** at the shore
stations. The hourly cadence exists to resolve the tidal cycle, which a fortnightly cadence
would alias into a meaningless slow oscillation; a shore station cannot support it because
each visit is a boat trip.

Every telemetered reading is stamped with its tidal phase. A reading without a phase stamp
is retained but cannot be compared against the shore series, and the quality-control pass
excludes it from any cross-station comparison.

## Replicate Samples

Field teams collect **three replicate samples** at each shore station. Three is the standard
for the programme because the boat trip, not the analysis, dominates the cost, so an extra
replicate is nearly free once the team is on site — but only three are taken, because the
shore stations are well mixed and the fourth replicate has never changed a decision.

Buoys do not take replicates in the sampling sense; they take a burst of 30 readings over
60 seconds and report the median. The median is used rather than the mean because a single
wave splash is a large positive outlier in exactly the quantities a buoy measures.

## Sensor Depth

The shore stations carry a sensor at **1 metre below the surface**, and the offshore buoys
carry a sensor at **2 metres below the surface**. The buoy depth is greater because a buoy
in the wave zone is repeatedly lifted and dropped by swell, and a sensor closer to the
surface is out of the water a meaningful fraction of the time.

Both depths are recorded as depth below the *instantaneous* surface. Coastal sensors are the
only programme where the surface reference changes fast enough to matter within a single
reading, so the timestamp and the depth are recorded together and neither is meaningful
alone.

## Parameters

The core parameters are water temperature, salinity, turbidity and wave height. Coastal
adds wave height, which no other programme records, and salinity, which only the estuary
programme also records but for a different reason.

Wave height is recorded as significant wave height, the mean of the highest third of waves
in the burst, not as the maximum. The maximum is recorded separately and is not used for
trend analysis because it is dominated by rare events.

## Quality Control

Telemetered readings are passed through a spike filter that rejects a value more than four
standard deviations from its 24-hour rolling mean. The filter has an override: a reading
that is also accompanied by a wave height above the 99th percentile is retained rather than
rejected, on the grounds that a storm is exactly when an unusual value is most likely to be
real.

Shore stations use a field blank and a blind duplicate, as the river and reservoir
programmes do. A station whose duplicate differs by more than 25 percent is re-visited,
which is a looser threshold than the reservoir programme's 20 percent because a coastal
station is inherently noisier and a tighter threshold flagged almost every visit.
