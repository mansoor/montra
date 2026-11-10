/**
 * The phone's Home charts (FLOW-01): a line chart sized to its card, bars for where the money went, and bars either
 * way from a middle line for differences. Each one also says it in words for screen readers and colour-blind eyes.
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Line, Polyline, Text as SvgText } from 'react-native-svg';
import { asCurrencyCode, barShares, minorUnits, sharePercent } from '@montra/domain';
import { labelIndexes, linePoints, valueRange } from '../features/chart-geometry';
import { currentLocale, fmtMoney, t } from '../i18n';
import { Small } from './components';
import { useTheme } from './theme';

/** "$12.3K" for an axis; the full amount when the phone can't do compact numbers. */
function axisMoney(minor: number, currency: string): string {
  try {
    const units = minorUnits(asCurrencyCode(currency));
    return new Intl.NumberFormat(currentLocale, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(minor / 10 ** units);
  } catch {
    return fmtMoney(BigInt(Math.trunc(minor)), currency);
  }
}

function monthLabel(date: string): string {
  try {
    return new Intl.DateTimeFormat(currentLocale, { month: 'short', timeZone: 'UTC' }).format(
      new Date(`${date}T00:00:00Z`),
    );
  } catch {
    return date.slice(5, 7);
  }
}

export interface ChartSeries {
  label: string;
  /** Minor units, one per month. */
  values: readonly string[];
}

export function MiniLineChart({
  series,
  months,
  currency,
  title,
  summary,
  fromZero = true,
  height = 140,
}: {
  series: readonly ChartSeries[];
  /** Month starts, one per point. */
  months: readonly string[];
  currency: string;
  title: string;
  /** What the chart shows, in words, for screen readers. */
  summary: string;
  fromZero?: boolean;
  height?: number;
}) {
  const th = useTheme();
  const [width, setWidth] = useState(0);
  const colors = [th.chart1, th.chart2, th.chart3];
  const range = valueRange(
    series.flatMap((s) => s.values.map(Number)),
    fromZero,
  );
  const box = { width, height, left: 52, right: 6, top: 6, bottom: 18 };
  const ticks = [range.max, (range.max + range.min) / 2, range.min];
  const y = (v: number) =>
    box.top + (1 - (v - range.min) / (range.max - range.min)) * (height - box.top - box.bottom);
  const shown = labelIndexes(months.length, 4);
  const xs = linePoints(
    months.map(() => 0),
    box,
    { min: 0, max: 1 },
  ).map((p) => p.x);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={`${title}. ${summary}`}>
      <Small>{title}</Small>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ height }}>
        {width > 0 ? (
          <Svg width={width} height={height}>
            {ticks.map((v, i) => (
              <Line
                key={`g${i}`}
                x1={box.left}
                x2={width - box.right}
                y1={y(v)}
                y2={y(v)}
                stroke={th.border}
                strokeDasharray="2 4"
              />
            ))}
            {ticks.map((v, i) => (
              <SvgText
                key={`t${i}`}
                x={box.left - 4}
                y={y(v) + 4}
                fontSize="10"
                fill={th.muted}
                textAnchor="end"
              >
                {axisMoney(v, currency)}
              </SvgText>
            ))}
            {range.min < 0 && range.max > 0 ? (
              <Line x1={box.left} x2={width - box.right} y1={y(0)} y2={y(0)} stroke={th.muted} />
            ) : null}
            {series.map((s, si) => (
              <Polyline
                key={s.label}
                points={linePoints(s.values.map(Number), box, range)
                  .map((p) => `${p.x},${p.y}`)
                  .join(' ')}
                fill="none"
                stroke={colors[si % colors.length]}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            ))}
            {shown.map((i) => (
              <SvgText
                key={`m${i}`}
                x={xs[i]}
                y={height - 4}
                fontSize="10"
                fill={th.muted}
                textAnchor={i === 0 ? 'start' : i === months.length - 1 ? 'end' : 'middle'}
              >
                {monthLabel(months[i]!)}
              </SvgText>
            ))}
          </Svg>
        ) : null}
      </View>
      {series.length > 1 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space(3) }}>
          {series.map((s, si) => (
            <View key={s.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View
                style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors[si % colors.length] }}
              />
              <Small>{s.label}</Small>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export interface BarItem {
  key: string;
  label: string;
  amount: string;
  onPress?: () => void;
}

/** Amounts that only go one way, largest first, each with its share of the total. */
export function BarList({
  rows,
  currency,
  total,
}: {
  rows: readonly BarItem[];
  currency: string;
  total: string;
}) {
  const th = useTheme();
  const widths = barShares(rows.map((r) => BigInt(r.amount)));
  return (
    <View style={{ gap: th.space(2) }}>
      {rows.map((r, i) => (
        <Pressable
          key={r.key}
          onPress={r.onPress}
          disabled={!r.onPress}
          accessibilityRole={r.onPress ? 'button' : undefined}
          accessibilityLabel={`${r.label}, ${fmtMoney(r.amount, currency)}, ${sharePercent(BigInt(r.amount), BigInt(total))}%`}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, gap: 4 })}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: th.space(2) }}>
            <Text style={{ color: th.text, fontSize: th.font.small, flexShrink: 1 }} numberOfLines={1}>
              {r.label}
            </Text>
            <Text style={{ color: th.text, fontSize: th.font.small, fontVariant: ['tabular-nums'] }}>
              {fmtMoney(r.amount, currency)}{' '}
              <Text style={{ color: th.muted }}>{sharePercent(BigInt(r.amount), BigInt(total))}%</Text>
            </Text>
          </View>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: th.surfaceAlt }}>
            <View
              style={{ height: 6, borderRadius: 3, width: `${widths[i]}%`, backgroundColor: th.primary }}
            />
          </View>
        </Pressable>
      ))}
    </View>
  );
}

export interface DeviationItem extends BarItem {
  /** Signed: positive is more spending than expected, negative less. */
  difference: string;
  detail?: string;
}

/** Differences either way from a middle line: more spending to the right in red, less to the left in green. */
export function DeviationBars({
  rows,
  currency,
  overKey,
  underKey,
}: {
  rows: readonly DeviationItem[];
  currency: string;
  overKey: string;
  underKey: string;
}) {
  const th = useTheme();
  const widths = barShares(rows.map((r) => BigInt(r.difference)));
  return (
    <View style={{ gap: th.space(2) }}>
      {rows.map((r, i) => {
        const d = BigInt(r.difference);
        const words =
          d > 0n
            ? t(overKey, { amount: fmtMoney(d, currency) })
            : t(underKey, { amount: fmtMoney(-d, currency) });
        return (
          <Pressable
            key={r.key}
            onPress={r.onPress}
            disabled={!r.onPress}
            accessibilityRole={r.onPress ? 'button' : undefined}
            accessibilityLabel={[r.label, words, r.detail].filter(Boolean).join(', ')}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, gap: 4 })}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: th.space(2) }}>
              <View style={{ flexShrink: 1 }}>
                <Text style={{ color: th.text, fontSize: th.font.small }} numberOfLines={1}>
                  {r.label}
                </Text>
                {r.detail ? <Small>{r.detail}</Small> : null}
              </View>
              <Text
                style={{ color: d > 0n ? th.danger : th.success, fontSize: th.font.small, fontWeight: '600' }}
              >
                {words}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', height: 6 }}>
              <View
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  justifyContent: 'flex-end',
                  backgroundColor: th.surfaceAlt,
                  borderTopLeftRadius: 3,
                  borderBottomLeftRadius: 3,
                }}
              >
                {d < 0n ? (
                  <View style={{ width: `${widths[i]}%`, backgroundColor: th.success, borderRadius: 3 }} />
                ) : null}
              </View>
              <View style={{ width: 1, backgroundColor: th.muted }} />
              <View
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  backgroundColor: th.surfaceAlt,
                  borderTopRightRadius: 3,
                  borderBottomRightRadius: 3,
                }}
              >
                {d > 0n ? (
                  <View style={{ width: `${widths[i]}%`, backgroundColor: th.danger, borderRadius: 3 }} />
                ) : null}
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
