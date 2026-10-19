// Getting the recovery codes out of the page: as text, as a file, on paper. They are shown only once, so each way matters.

export function codesText(codes, now = new Date()) {
  return [
    'Shipdok recovery codes',
    `Made ${now.toISOString().slice(0, 10)}`,
    '',
    'Each code works ONCE and lets you set a new password if you forget yours.',
    'Making a new set replaces all of these. Keep them somewhere safe and private.',
    '',
    ...codes,
    '',
  ].join('\n')
}

export function downloadCodes(codes) {
  const url = URL.createObjectURL(new Blob([codesText(codes)], { type: 'text/plain' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'shipdok-recovery-codes.txt'
  link.click()
  link.remove?.()
  URL.revokeObjectURL(url)
}

/** Opens a plain page with just the codes and the print dialog. False if the browser refused to open the window. */
export function printCodes(codes) {
  const win = window.open('', '_blank')
  if (!win) return false
  const items = codes.map((c) => `<li>${c}</li>`).join('')
  win.document.write(`<!doctype html><title>Shipdok recovery codes</title><body style="font-family:monospace"><h1>Shipdok recovery codes</h1><p>Each code works once and sets a new password. A new set replaces these.</p><ol style="font-size:18px;line-height:2">${items}</ol>`)
  win.document.close()
  win.focus()
  win.print()
  return true
}
