// Browser half of dsh-plugin-mobile-link. DSH loads this module from the
// package's `./client` export and hands it the client slot service. It adds one
// sidebar footer action ("移动设备") and one shell overlay that shows the
// pairing QR and trusted devices. No Harness client package is imported.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-mobile-link',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    let open = false
    const listeners = new Set()
    const subscribe = (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    const getOpen = () => open
    const setOpen = (value) => {
      if (open === value) return
      open = value
      for (const listener of listeners) listener()
    }

    const api = async (path, options) => {
      const response = await fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...(options || {}),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(body.message || body.error || `HTTP ${response.status}`)
      }
      return body
    }

    const styles = {
      backdrop: {
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(0,0,0,.38)',
        backdropFilter: 'blur(6px)',
      },
      panel: {
        width: 'min(760px, calc(100vw - 48px))',
        maxHeight: 'min(760px, calc(100vh - 64px))',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 18,
        background: 'var(--dsw-alias-bg-layer-1, Canvas)',
        color: 'var(--dsw-alias-label-primary, CanvasText)',
        boxShadow: '0 24px 80px rgba(0,0,0,.28)',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.22))',
        font: '14px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '16px 18px 12px',
      },
      title: { fontSize: 18, fontWeight: 650, margin: 0 },
      iconButton: {
        marginLeft: 'auto',
        width: 34,
        height: 34,
        borderRadius: 10,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 19,
      },
      body: {
        overflowY: 'auto',
        padding: '0 18px 18px',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 300px)',
        gap: 18,
      },
      card: {
        border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.22))',
        borderRadius: 14,
        padding: 14,
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.04))',
        minWidth: 0,
      },
      sectionTitle: { fontSize: 14, fontWeight: 650, margin: '0 0 8px' },
      muted: { color: 'var(--dsw-alias-label-secondary, #777)', fontSize: 12.5, margin: '4px 0' },
      code: {
        display: 'block',
        fontSize: 11,
        lineHeight: 1.5,
        wordBreak: 'break-all',
        userSelect: 'all',
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-overlay, rgba(127,127,127,.12))',
        marginTop: 8,
      },
      button: {
        font: 'inherit',
        fontSize: 13.5,
        padding: '8px 14px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.3))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        background: 'var(--dsw-alias-interactive-bg-accent, #3b82f6)',
        borderColor: 'transparent',
        color: '#fff',
      },
      qrBox: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        marginTop: 10,
      },
      qr: {
        width: 236,
        height: 236,
        borderRadius: 12,
        background: '#fff',
        padding: 8,
        imageRendering: 'pixelated',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 0',
        borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.16))',
      },
      dot: { width: 8, height: 8, borderRadius: 999, flex: '0 0 auto' },
      empty: { color: 'var(--dsw-alias-label-secondary, #777)', fontSize: 13, padding: '10px 0' },
      error: { color: 'var(--dsw-alias-state-error, #dc2626)', fontSize: 13, margin: '8px 0' },
      badge: {
        marginLeft: 'auto',
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-overlay, rgba(127,127,127,.12))',
        color: 'var(--dsw-alias-label-secondary, #777)',
        flex: '0 0 auto',
      },
    }

    const phoneIcon = (size = 18) => React.createElement('svg', {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
      React.createElement('rect', { x: 6, y: 2, width: 12, height: 20, rx: 2.5 }),
      React.createElement('path', { d: 'M10 18h4' }))

    const fullHost = (url) => {
      try {
        const parsed = new URL(url)
        return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
      } catch {
        return String(url || '')
      }
    }

    const deviceLabel = (device) => device.displayName || device.name || '未命名设备'

    function statusDot(online) {
      return { ...styles.dot, background: online ? '#22c55e' : 'var(--dsw-alias-label-tertiary, #9ca3af)' }
    }

    function FooterButton(props) {
      const isOpen = useSyncExternalStore(subscribe, getOpen)
      const wide = !!props.wide
      return React.createElement('button', {
        type: 'button',
        title: '移动设备',
        'aria-label': '移动设备',
        'aria-pressed': isOpen,
        onClick: () => setOpen(!isOpen),
        style: {
          cursor: 'pointer',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          font: 'inherit',
          display: 'flex',
          alignItems: 'center',
          justifyContent: wide ? 'flex-start' : 'center',
          gap: wide ? 8 : 0,
          boxSizing: 'border-box',
          width: wide ? 'calc(100% + 4px)' : 36,
          height: wide ? 42 : 36,
          margin: wide ? '4px -2px' : '3px 0',
          padding: wide ? '0 10px 0 8px' : 0,
          lineHeight: wide ? '22px' : 'normal',
          borderRadius: 10,
        },
      }, phoneIcon(wide ? 16 : 18), wide ? React.createElement('span', null, '移动设备') : null)
    }

    function DeviceRow({ device, onRevoke, revoking }) {
      return React.createElement('div', { style: styles.row },
        React.createElement('span', { style: statusDot(device.online) }),
        React.createElement('div', { style: { minWidth: 0, overflow: 'hidden' } },
          React.createElement('div', {
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 550 },
          }, deviceLabel(device)),
          React.createElement('div', { style: { ...styles.muted, margin: 0 } },
            device.online ? '在线' : device.lastSeenAt ? '离线 · 最近连接' : '尚未连接')),
        React.createElement('span', { style: styles.badge }, device.online ? `${device.connections || 1} 个连接` : '离线'),
        React.createElement('button', {
          type: 'button',
          style: { ...styles.button, padding: '5px 10px', fontSize: 12 },
          disabled: revoking,
          onClick: () => onRevoke(device),
        }, revoking ? '移除中…' : '移除'))
    }

    function Panel() {
      const isOpen = useSyncExternalStore(subscribe, getOpen)
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const [pairing, setPairing] = useState(null)
      const [pairingError, setPairingError] = useState('')
      const [generating, setGenerating] = useState(false)
      const [revoking, setRevoking] = useState('')
      const [copied, setCopied] = useState(false)
      const [now, setNow] = useState(Date.now())
      const generatingRef = useRef(false)
      const expiredAttemptRef = useRef('')

      const refreshStatus = useCallback(async () => {
        try {
          const next = await api('/mobile-link/status')
          setStatus(next)
          setError('')
          return next
        } catch (err) {
          setError(err.message || '读取网关状态失败')
          return null
        }
      }, [])

      const generatePairing = useCallback(async () => {
        if (generatingRef.current) return
        generatingRef.current = true
        setGenerating(true)
        setPairingError('')
        try {
          const next = await api('/mobile-link/pair', { method: 'POST' })
          setPairing(next)
          setCopied(false)
          setNow(Date.now())
        } catch (err) {
          setPairingError(err.message || '生成二维码失败')
        } finally {
          generatingRef.current = false
          setGenerating(false)
        }
      }, [])

      useEffect(() => {
        if (!isOpen) return undefined
        setPairing(null)
        setPairingError('')
        refreshStatus().then((next) => {
          if (next) generatePairing()
        })
        const statusTimer = setInterval(refreshStatus, 3000)
        const clockTimer = setInterval(() => setNow(Date.now()), 1000)
        return () => {
          clearInterval(statusTimer)
          clearInterval(clockTimer)
        }
      }, [isOpen, refreshStatus, generatePairing])

      useEffect(() => {
        if (!isOpen) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [isOpen])

      // 二维码过期后自动换一张，避免用户对着失效码反复扫。
      useEffect(() => {
        if (!isOpen || !pairing) return
        const expiresAt = pairing.payload && pairing.payload.expiresAt
        if (!expiresAt || now < expiresAt) return
        const online = (status && status.devices || []).some((device) => device.online)
        if (online || expiredAttemptRef.current === pairing.raw) return
        expiredAttemptRef.current = pairing.raw
        generatePairing()
      }, [isOpen, pairing, now, status, generatePairing])

      const copyRaw = async () => {
        const raw = pairing && pairing.raw
        if (!raw) return
        try {
          await navigator.clipboard.writeText(raw)
          setCopied(true)
          setTimeout(() => setCopied(false), 1800)
        } catch {
          setPairingError('浏览器不允许直接写剪贴板，请选中下方文本手动复制')
        }
      }

      const revoke = async (device) => {
        setRevoking(device.id)
        try {
          await api('/mobile-link/revoke', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: device.id }),
          })
          await refreshStatus()
        } catch (err) {
          setError(err.message || '移除设备失败')
        } finally {
          setRevoking('')
        }
      }

      if (!isOpen) return null

      const devices = (status && status.devices) || []
      const endpoints = (status && status.endpoints) || []
      const lanUrl = endpoints[0] || ''
      const expiresAt = pairing && pairing.payload && pairing.payload.expiresAt
      const remaining = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0
      const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
      const qr = pairing && pairing.qr
      const raw = pairing && pairing.raw

      return React.createElement('div', {
        style: styles.backdrop,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) setOpen(false)
        },
      }, React.createElement('section', {
        style: styles.panel,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '移动设备',
      },
        React.createElement('header', { style: styles.header },
          phoneIcon(20),
          React.createElement('h2', { style: styles.title }, '移动设备'),
          React.createElement('span', { style: { ...styles.muted, margin: 0 } },
            status ? `DSH · ${status.gatewayName || '当前电脑'}` : '正在读取网关状态…'),
          React.createElement('button', {
            type: 'button',
            style: styles.iconButton,
            title: '关闭',
            'aria-label': '关闭',
            onClick: () => setOpen(false),
          }, '×')),
        React.createElement('div', { style: styles.body },
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 } },
            React.createElement('div', { style: styles.card },
              React.createElement('h3', { style: styles.sectionTitle }, '扫码连接手机'),
              React.createElement('p', { style: styles.muted },
                '手机与这台电脑在同一个局域网时，用 DSH App 扫描右侧二维码即可配对。配对后手机可以直接查看并继续电脑上的对话。'),
              React.createElement('p', { style: styles.muted },
                lanUrl ? `局域网地址：${fullHost(lanUrl)}` : '尚未找到可用的局域网地址，请确认电脑已联网。'),
              React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } },
                React.createElement('button', {
                  type: 'button',
                  style: { ...styles.button, ...styles.primary },
                  disabled: generating,
                  onClick: generatePairing,
                }, generating ? '正在生成…' : '刷新二维码'),
                React.createElement('button', {
                  type: 'button',
                  style: styles.button,
                  disabled: !raw,
                  onClick: copyRaw,
                }, copied ? '已复制' : '复制配对内容')),
              pairingError ? React.createElement('p', { style: styles.error }, pairingError) : null),

            React.createElement('div', { style: styles.card },
              React.createElement('h3', { style: styles.sectionTitle }, '已配对设备'),
              devices.length === 0
                ? React.createElement('div', { style: styles.empty }, '还没有设备，先用手机扫码配对。')
                : devices.map((device) => React.createElement(DeviceRow, {
                  key: device.id,
                  device,
                  revoking: revoking === device.id,
                  onRevoke: revoke,
                })),
              error ? React.createElement('p', { style: styles.error }, error) : null)),

          React.createElement('div', { style: styles.card },
            React.createElement('h3', { style: styles.sectionTitle }, '配对二维码'),
            qr
              ? React.createElement('div', { style: styles.qrBox },
                React.createElement('img', { src: qr, alt: '设备配对二维码', style: styles.qr }),
                React.createElement('div', { style: { ...styles.muted, margin: 0, textAlign: 'center' } },
                  remaining > 0 ? `有效期剩余 ${countdown}，扫码成功后立即失效` : '二维码已过期，正在刷新…'))
              : React.createElement('div', { style: styles.empty }, generating ? '正在生成二维码…' : '暂无二维码'),
            raw ? React.createElement('code', { style: styles.code }, raw) : null,
            React.createElement('p', { style: { ...styles.muted, marginTop: 10 } },
              '手机端：登录页 → 扫一扫连接电脑。相机不可用时，可把上面的配对内容复制到手机的「手动填写」里。'))))
      )
    }

    function OverlayEntry() {
      return React.createElement(Panel)
    }

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'mobile-link-devices', order: 80, label: '移动设备' },
        (props) => React.createElement(FooterButton, props),
      ))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'mobile-link-devices-panel', order: 100, label: '移动设备' },
        () => React.createElement(OverlayEntry),
      ))
    }

    return { inject, apply }
  },
})
