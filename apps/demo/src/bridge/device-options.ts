export const rateValues = [10, 100, 1000, 10000] as const;
type RateValue = (typeof rateValues)[number];
const rateLabels: Readonly<Record<RateValue, string>> = {
  10: "10/s",
  100: "100/s",
  1000: "1000/s",
  10000: "10000/s stress",
};
export const rateOptions = rateValues.map((value) => ({
  value,
  label: rateLabels[value],
}));

export const samplingValues = [0, 10, 100] as const;
type SamplingValue = (typeof samplingValues)[number];
const samplingLabels: Readonly<Record<SamplingValue, string>> = {
  0: "Off",
  10: "10 ms",
  100: "100 ms",
};
export const samplingOptions = samplingValues.map((value) => ({
  value,
  label: samplingLabels[value],
}));
