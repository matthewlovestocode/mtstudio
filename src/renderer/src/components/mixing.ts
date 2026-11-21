import type { Curve } from './controls/value'

/** A level as decibels: "-6.0", "+2.1", "-∞". */
export function decibels(gain: number): string {
  if (gain <= 0) return '-∞'
  const db = 20 * Math.log10(gain)
  return `${db >= 0.05 ? '+' : ''}${db.toFixed(1)}`
}

export function panText(pan: number): string {
  const amount = Math.round(Math.abs(pan) * 100)
  return amount === 0 ? 'C' : `${pan < 0 ? 'L' : 'R'}${amount}`
}

const MAX_GAIN = 1.5

/**
 * A volume fader's taper: travel squared, so the top half of the fader covers
 * the last twelve decibels or so and the bottom fades out to silence. Unity
 * sits about four fifths of the way up.
 */
export const VOLUME_CURVE: Curve = {
  toPosition: (gain) => Math.sqrt(Math.max(0, gain) / MAX_GAIN),
  toValue: (position) => MAX_GAIN * position * position
}

const fromDb = (db: number): number => 10 ** (db / 20)

export const VOLUME_TICKS = [
  { value: fromDb(3), label: '+3' },
  { value: 1, label: '0' },
  { value: fromDb(-6), label: '6' },
  { value: fromDb(-12), label: '12' },
  { value: fromDb(-24), label: '24' },
  { value: 0, label: '∞' }
]
