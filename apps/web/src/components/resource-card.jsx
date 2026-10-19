import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { LoadError } from '@/components/states'
import { useStats } from '@/lib/queries'
import { chartPoints, clock, cpuCeiling, cpuTicks, formatCpu, formatMemory, memoryPercent, memoryTicks } from '@/lib/stats'

const CPU_CONFIG = { cpu: { label: 'CPU', color: 'var(--info)' } }
const MEMORY_CONFIG = { memory: { label: 'Memory', color: 'var(--primary)' } }

function Figure({ label, children, hint }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold">{children}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  )
}

function Chart({ label, config, dataKey, points, unit, ceiling, ticks, limit }) {
  return (
    <div role="img" aria-label={label}>
      <ChartContainer config={config} className="aspect-auto h-36 w-full">
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="time" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={clock} tickLine={false} axisLine={false} minTickGap={48} />
          <YAxis width={64} domain={[0, ceiling ?? 'auto']} ticks={ticks} tickFormatter={(v) => `${Math.round(v)}${unit === '%' ? '%' : ' MB'}`} tickLine={false} axisLine={false} />
          {limit ? <ReferenceLine y={limit} stroke="var(--muted-foreground)" strokeDasharray="4 4" /> : null}
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => clock(p?.[0]?.payload?.time)} formatter={(v) => `${Math.round(v * 10) / 10} ${unit}`} />} />
          <Area dataKey={dataKey} type="monotone" stroke={`var(--color-${dataKey})`} fill={`var(--color-${dataKey})`} fillOpacity={0.15} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
        </AreaChart>
      </ChartContainer>
    </div>
  )
}

/** CPU and memory of the running app: the numbers now, and the last hour as charts. */
export default function ResourceCard({ app }) {
  const stats = useStats(app.id)
  if (stats.isError) return <Card><CardContent className="pt-6"><LoadError error={stats.error} title="Could not load the resource use" onRetry={() => stats.refetch()} /></CardContent></Card>

  const latest = stats.data?.latest ?? null
  const points = chartPoints(stats.data?.samples)
  const pct = memoryPercent(latest)
  const limitMb = latest?.memoryLimitBytes ? latest.memoryLimitBytes / (1024 * 1024) : null

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">Resource use</CardTitle>
        <CardDescription>
          {latest ? 'Measured every 15 seconds. CPU is a share of one processor, so a busy app can pass 100%.' : 'Shown while the app is running.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-4">
          <Figure label="CPU now">{latest ? formatCpu(latest.cpuPercent) : '—'}</Figure>
          <Figure label="Memory now" hint={pct === null ? undefined : `${pct}% of its limit`}>{latest ? formatMemory(latest) : '—'}</Figure>
        </dl>
        {stats.isPending ? <p className="text-sm text-muted-foreground" role="status">Loading…</p> : points.length < 2 ? (
          <p className="text-sm text-muted-foreground">{latest ? 'The charts appear once a few measurements are in.' : 'No measurements in the last hour.'}</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div><p className="mb-1 text-xs font-medium text-muted-foreground">CPU, last hour</p><Chart label="CPU use over the last hour" config={CPU_CONFIG} dataKey="cpu" points={points} unit="%" ceiling={cpuCeiling(points)} ticks={cpuTicks(cpuCeiling(points))} /></div>
            <div><p className="mb-1 text-xs font-medium text-muted-foreground">Memory, last hour (dashed line: the limit)</p><Chart label="Memory use over the last hour" config={MEMORY_CONFIG} dataKey="memory" points={points} unit=" MB" limit={limitMb} ceiling={limitMb ? Math.round(limitMb) : undefined} ticks={memoryTicks(limitMb)} /></div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
