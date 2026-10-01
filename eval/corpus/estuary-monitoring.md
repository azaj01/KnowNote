# Estuary Monitoring Programme

## Overview

Estuary monitoring tracks the mixing zone where a river meets the sea. Its distinguishing
problem is that the water body has a gradient in all three dimensions at once: salinity and
turbidity change sharply over a few kilometres, and the position of that gradient moves with
the tide and with river flow.

The programme covers two estuaries, each with a transect of five stations running from the
freshwater end to the mouth. A transect is the unit of reporting, not a station, because a
single station in an estuary describes a position in a gradient that has moved by the time
the next station is sampled.

## Sampling Interval

Routine sampling runs **daily** at the two lowest stations and **fortnightly** along the
rest of the transect. Daily sampling at the lower stations is used to track the salt wedge,
whose position responds to the tide within hours; the upper transect responds to river flow
over days and does not need it.

Transect sampling is run on the ebb tide, and every station is occupied within a single ebb
to keep the transect a snapshot rather than a sequence. A transect that overruns its ebb is
discarded and repeated, because a transect sampled across a tidal reversal is not a gradient.

## Replicate Samples

Field teams collect **five replicate samples** at each transect station, the highest of any
programme in the network. Five because the estuary gradient means two samples taken a metre
apart can differ more than two samples taken a kilometre apart at a well-mixed site; the
within-station variance is high enough that three replicates do not estimate a mean reliably.

Replicates are taken as a spatial cross rather than as a sequence: one at the nominal
position and four at 25 metres on each axis. A sequential set of replicates would all sample
the same parcel of water and would understate the variance that matters.

## Sensor Depth

Transect stations carry sensors at **2 metres below the surface** and at 1 metre above the
bed, paired so that the vertical salinity difference can be computed directly. The surface
depth is fixed at 2 metres rather than at 1 metre to keep the sensor below the freshwater
lens that floats on the saline layer at the freshwater end.

The paired depths are the programme's defining feature. A single sensor in an estuary cannot
distinguish a change in salinity from a change in where the halocline sits, and those are
different findings.

## Parameters

The core parameters are salinity, turbidity, dissolved oxygen and temperature. Estuary adds
the position of the turbidity maximum, which is the programme's headline product and is not
recorded by any other programme.

The turbidity maximum is reported as a distance from the freshwater end, not as a turbidity
value. Its position moves several kilometres over a tidal cycle, and a turbidity value
without a position cannot distinguish a stationary maximum from a passing one.

## Quality Control

Every transect includes one blind duplicate at a randomly chosen station. Precision is
estimated per transect rather than per station, because the quantity the programme reports
is a gradient and the error that matters is the error in the gradient.

A transect whose blind duplicate differs by more than 30 percent is repeated. The threshold
is looser than any other programme's, and deliberately so: an estuary's true variance is
genuinely larger, and a tighter threshold would cause every transect to be repeated, which
in practice means none of them are.
