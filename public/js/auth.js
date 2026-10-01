function togglePassword(inputId, button) {
  const input = document.getElementById(inputId)
  const icon = button.querySelector('.material-symbols-outlined')
  if (input.type === 'password') {
    input.type = 'text'
    icon.textContent = 'visibility_off'
  } else {
    input.type = 'password'
    icon.textContent = 'visibility'
  }
}

document.addEventListener('DOMContentLoaded', function () {
  const html = document.documentElement
  const themeToggle = document.getElementById('auth-theme-toggle')

  const saved = localStorage.getItem('blastyuk-theme') || 'light'
  html.setAttribute('data-theme', saved)
  updateIcon(saved)

  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      const current = html.getAttribute('data-theme')
      const next = current === 'dark' ? 'light' : 'dark'
      html.setAttribute('data-theme', next)
      localStorage.setItem('blastyuk-theme', next)
      updateIcon(next)
    })
  }

  function updateIcon(theme) {
    if (!themeToggle) return
    const icon = themeToggle.querySelector('.material-symbols-outlined')
    if (icon) icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode'
  }
})