// Collapses flat AbtEgpPhayaoItem docs into one project card per projectId (falling back
// to the link when a project id couldn't be parsed, so those still show up as their own card).
function buildProjectCards(items, { minAmount, maxAmount, status } = {}) {
  const groups = new Map()
  for (const item of items) {
    const key = item.projectId || item.link
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }

  const now = Date.now()
  let projects = Array.from(groups.entries()).map(([projectId, announcements]) => {
    const sorted = announcements.slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    const latest = sorted[0]
    const amount = sorted.find((a) => a.amount != null)?.amount
      ?? sorted.find((a) => a.budget != null)?.budget
      ?? null
    const closingDate = sorted.find((a) => a.closingDate)?.closingDate || null
    const projectStatus = closingDate
      ? (new Date(closingDate).getTime() >= now ? 'open' : 'closed')
      : 'unknown'

    return {
      projectId,
      title: latest.title,
      agency: sorted.find((a) => a.agency)?.agency || null,
      method: sorted.find((a) => a.method)?.method || null,
      winner: sorted.find((a) => a.winner)?.winner || null,
      amount,
      closingDate,
      status: projectStatus,
      latestDate: latest.date,
      announcements: sorted.map((a) => ({
        link: a.link, anounceType: a.anounceType, title: a.title, date: a.date, desc: a.desc,
      })),
    }
  })

  if (minAmount != null) projects = projects.filter((p) => p.amount != null && p.amount >= Number(minAmount))
  if (maxAmount != null) projects = projects.filter((p) => p.amount != null && p.amount <= Number(maxAmount))
  if (status) projects = projects.filter((p) => p.status === status)

  projects.sort((a, b) => new Date(b.latestDate || 0) - new Date(a.latestDate || 0))
  return projects
}

module.exports = { buildProjectCards }
