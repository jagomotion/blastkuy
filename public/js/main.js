document.addEventListener('DOMContentLoaded', function () {
  const html = document.documentElement
  const themeToggle = document.getElementById('theme-toggle')

  fetch('/api/theme')
    .then(function (r) { return r.json() })
    .then(function (data) {
      const theme = data.theme || 'light'
      html.setAttribute('data-theme', theme)
      updateThemeIcon(theme)
    })

  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      const current = html.getAttribute('data-theme')
      const next = current === 'dark' ? 'light' : 'dark'
      html.setAttribute('data-theme', next)
      updateThemeIcon(next)
      fetch('/api/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next })
      })
    })
  }

  function updateThemeIcon(theme) {
    if (!themeToggle) return
    const icon = themeToggle.querySelector('.material-symbols-outlined')
    if (icon) icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode'
  }

  const connectForm = document.getElementById('connect-form')
  if (connectForm) {
    connectForm.addEventListener('submit', async function (e) {
      e.preventDefault()
      const formData = new FormData(connectForm)
      const payload = Object.fromEntries(formData)
      const result = document.getElementById('connect-result')
      result.innerHTML = '<div class="alert"><span class="material-symbols-outlined">sync</span> Menghubungkan...</div>'
      try {
        const res = await fetch('/api/connect-whatsapp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        const data = await res.json()
        if (data.error) {
          result.innerHTML = '<div class="alert alert-error">' + data.error + '</div>'
          return
        }
        if (data.type === 'pairing') {
          result.innerHTML =
            '<div class="card">' +
            '<h2><span class="material-symbols-outlined">key</span> Pairing Code</h2>' +
            '<div class="pairing-code">' + data.code + '</div>' +
            '<p class="muted">Buka WhatsApp > Perangkat Tertaut > Tautkan Perangkat > Tautkan dengan nomor telepon</p>' +
            '</div>'
        } else if (data.type === 'qr') {
          const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' + encodeURIComponent(data.qr)
          result.innerHTML =
            '<div class="card">' +
            '<h2><span class="material-symbols-outlined">qr_code</span> Scan QR</h2>' +
            '<div class="qr-container"><img src="' + qrUrl + '" alt="QR"></div>' +
            '<p class="muted">Scan QR dengan WhatsApp > Perangkat Tertaut</p>' +
            '</div>'
        } else if (data.type === 'connected') {
          result.innerHTML = '<div class="alert" style="background:var(--success-soft);color:var(--success)">Akun terhubung</div>'
          setTimeout(function () { window.location.href = '/accounts' }, 1200)
        }
      } catch (err) {
        result.innerHTML = '<div class="alert alert-error">' + err.message + '</div>'
      }
    })
  }

  const broadcastForm = document.getElementById('broadcast-form')
  if (broadcastForm) {
    broadcastForm.addEventListener('submit', async function (e) {
      e.preventDefault()
      const checked = broadcastForm.querySelectorAll('input[name="accounts"]:checked')
      const accounts = Array.from(checked).map(function (c) { return c.value })
      const speed = broadcastForm.querySelector('input[name="speed"]:checked').value
      if (accounts.length === 0) {
        alert('Pilih minimal satu akun')
        return
      }
      document.getElementById('stop-btn').disabled = false
      document.getElementById('progress-fill').style.width = '0%'
      document.getElementById('progress-text').textContent = '0 / 0 pesan'
      document.getElementById('progress-percent').textContent = '0%'
      document.getElementById('stat-sent').textContent = '0'
      document.getElementById('stat-failed').textContent = '0'
      document.getElementById('live-messages').innerHTML = ''
      try {
        await fetch('/api/broadcast/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ speed: speed, accounts: accounts })
        })
      } catch (err) {
        alert(err.message)
      }
    })
  }

  const stopBtn = document.getElementById('stop-btn')
  if (stopBtn) {
    stopBtn.addEventListener('click', async function () {
      stopBtn.disabled = true
      await fetch('/api/broadcast/stop', { method: 'POST' })
    })
  }

  const liveMessages = document.getElementById('live-messages')
  if (liveMessages) {
    const stream = new EventSource('/api/broadcast/stream')

    stream.onmessage = function (e) {
      let data
      try { data = JSON.parse(e.data) } catch (_) { return }

      if (data.type === 'progress') {
        const pct = data.total > 0 ? Math.round((data.sent + data.failed) / data.total * 100) : 0
        document.getElementById('progress-fill').style.width = pct + '%'
        document.getElementById('progress-text').textContent = (data.sent + data.failed) + ' / ' + data.total + ' pesan'
        document.getElementById('progress-percent').textContent = pct + '%'
        document.getElementById('stat-sent').textContent = data.sent
        document.getElementById('stat-failed').textContent = data.failed

        if (data.message) {
          const div = document.createElement('div')
          div.className = 'msg ' + data.message.status
          const iconName = data.message.status === 'sent' ? 'check_circle' : 'error'
          div.innerHTML = '<span class="material-symbols-outlined">' + iconName + '</span> ' + data.message.phone
          liveMessages.prepend(div)
          while (liveMessages.children.length > 100) {
            liveMessages.removeChild(liveMessages.lastChild)
          }
        }
      } else if (data.type === 'complete') {
        document.getElementById('stop-btn').disabled = true
        const pct = 100
        document.getElementById('progress-fill').style.width = pct + '%'
        document.getElementById('progress-percent').textContent = '100%'
        const div = document.createElement('div')
        div.className = 'msg sent'
        div.style.background = 'var(--primary-soft)'
        div.style.color = 'var(--primary)'
        div.innerHTML = '<span class="material-symbols-outlined">task_alt</span> Broadcast selesai. ' + data.sent + ' terkirim, ' + data.failed + ' gagal'
        liveMessages.prepend(div)
      } else if (data.type === 'error') {
        alert(data.message)
        document.getElementById('stop-btn').disabled = true
      }
    }

    stream.onerror = function () {
      stream.close()
    }
  }
})