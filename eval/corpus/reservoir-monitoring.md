# Reservoir Monitoring Programme

## Overview

Reservoir monitoring tracks a standing water body whose level is managed rather than
natural. The programme's distinguishing problem is that the water body has an operator:
every measurement has to be paired with the release schedule, or a change in a reading is
indistinguishable from a change in how the reservoir was run that week.

The programme covers three reservoirs in the upland basin. Each has a fixed monitoring
station at the dam face and two floating stations whose position is recorded on every
visit, because a reservoir's surface area changes enough over a season to move a floating
station hundreds of metres without anyone touching it.

## Sampling Interval

Routine sampling runs **fortnightly**, on a fixed Tuesday, so that the interval is
consistent across sites and operators. A fortnightly cadence is a deliberate compromise:
weekly was found to double cost without changing any trend, and monthly aliased against
the operator's own drawdown cycle, which is also roughly monthly and made the series very
hard to interpret.

Event sampling is triggered by any release exceeding 20 percent of live capacity in a
single day. Event samples are additional to the routine cadence and are labelled with the
release event rather than with the calendar.

## Replicate Samples

Field teams collect **four replicate samples** at each station to control for local
variability. Four rather than three because the reservoir stations sit in a drawdown zone
where wind-driven mixing produces an occasional outlier; with three replicates a single
outlier is a third of the mean, and with four it can be identified and excluded on a stated
rule rather than discarded by feel.

Replicates are taken within a 15-minute window. A replicate that falls outside that window
is recorded but excluded from the mean, because the reservoir can stratify and destratify on
that timescale in summer.

## Sensor Depth

The fixed station carries a sensor string at **5 metres below the surface**, and the two
floating stations carry a single sensor at **1 metre below the surface**. The asymmetry is
intentional: the dam face is deep and well mixed, while the floating stations are in the
drawdown zone where the interesting gradient is in the top metre.

Depth is recorded as depth below the *current* surface, not below full capacity. Because the
surface moves, a sensor on a fixed string is at a different absolute elevation at different
times, and the programme records both so that a reader can reconstruct which was meant.

## Parameters

The core parameters are water temperature, dissolved oxygen, turbidity and chlorophyll-a.
Reservoir-specific parameters are residence time and drawdown rate, neither of which the
river or lake programmes record because neither has an operator-controlled outlet.

Turbidity is recorded as the primary indicator of sediment resuspension during drawdown,
which is the process the programme exists to quantify. Chlorophyll-a is recorded as the
primary indicator of the algal response to nutrient loading.

## Quality Control

Every routine visit includes one field blank and one duplicate submitted blind. The
duplicate is used to estimate within-station precision; the blank is used to detect
contamination introduced by the sampling kit rather than by the reservoir.

A station whose blind duplicate differs by more than 20 percent is flagged and re-visited
within seven days. Two consecutive flags retire the station's sensor string, because the
most common cause of a persistent discrepancy is a drifting sensor rather than a genuinely
patchy water body.
