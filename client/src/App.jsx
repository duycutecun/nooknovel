import React, { useEffect, useState } from 'react'
import { db, auth } from './firebase'
import { collection, onSnapshot, doc, setDoc, serverTimestamp, getDocs } from 'firebase/firestore'
import { signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth'
import './styles.css'

export default function App() {
  const [novels, setNovels] = useState([])
  const [selected, setSelected] = useState(null)
  const [userUid, setUserUid] = useState(null)
  const [position, setPosition] = useState(null)
  const [bookmarks, setBookmarks] = useState([])
  const [logs, setLogs] = useState([])
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const [pages, setPages] = useState([])
  const [currentPage, setCurrentPage] = useState(1)
  const [fontSize, setFontSize] = useState(parseInt(localStorage.getItem('fontSize') || '18'))
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'day')
  const [authPanelOpen, setAuthPanelOpen] = useState(false)
  const [authTab, setAuthTab] = useState('signin')
  const [userInfo, setUserInfo] = useState(null)
  const [view, setView] = useState('home')
  const [currentTab, setCurrentTab] = useState('home')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.style.fontSize = fontSize + 'px'
    localStorage.setItem('fontSize', fontSize)
  }, [fontSize])

  useEffect(() => {
    signInAnonymously(auth).catch(e => addLog('Đăng nhập ẩn danh thất bại: ' + (e.message || e)))
    const unsubAuth = onAuthStateChanged(auth, user => {
      if (user) {
        setUserUid(user.uid)
        setUserInfo({
          displayName: user.displayName,
          email: user.email,
          photoURL: user.photoURL,
          isAnonymous: user.isAnonymous
        })
        addLog('Đã đăng nhập: ' + (user.displayName || user.uid.slice(-6)))
      } else {
        setUserUid(null)
        setUserInfo(null)
      }
    })

    const col = collection(db, 'novels')
    const unsubNovels = onSnapshot(col, snap => {
      setNovels(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      addLog('Thư viện được cập nhật')
    }, err => addLog('Lỗi tải truyện: ' + (err.message || err)))

    refreshNovels().catch(() => {})

    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      unsubNovels()
      unsubAuth()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  useEffect(() => {
    if (!selected) {
      setPages([])
      setCurrentPage(1)
      return
    }

    const content = selected.content || ''
    const pageSize = 2200
    const slices = []
    for (let i = 0; i < content.length; i += pageSize) {
      slices.push(content.slice(i, i + pageSize))
    }
    setPages(slices)
    setCurrentPage(1)
  }, [selected])

  useEffect(() => {
    if (!userUid || !selected) {
      setPosition(null)
      return
    }

    const posRef = doc(db, `users/${userUid}/positions/${selected.id}`)
    const bookmarksRef = collection(db, `users/${userUid}/bookmarks`)

    const unsubPos = onSnapshot(posRef, snap => {
      setPosition(snap.exists() ? snap.data().position : null)
    }, err => addLog('Lỗi vị trí: ' + (err.message || err)))

    const unsubBookmarks = onSnapshot(bookmarksRef, snap => {
      setBookmarks(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => b.novelId === selected.id))
    }, err => addLog('Lỗi bookmarks: ' + (err.message || err)))

    return () => {
      unsubPos()
      unsubBookmarks()
    }
  }, [userUid, selected])

  async function refreshNovels() {
    try {
      const col = collection(db, 'novels')
      const snap = await getDocs(col)
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      setNovels(items)
      addLog('Đã tải ' + items.length + ' truyện')
    } catch (err) {
      addLog('Refresh thất bại: ' + (err.message || err))
    }
  }

  function addLog(message) {
    setLogs(prev => [message, ...prev].slice(0, 60))
  }

  const signInGoogle = async () => {
    try {
      const provider = new GoogleAuthProvider()
      await signInWithPopup(auth, provider)
      addLog('Đã đăng nhập Google')
    } catch (err) {
      addLog('Google sign-in failed: ' + (err.message || err))
    }
  }

  const signOutUser = async () => {
    try {
      await signOut(auth)
      setUserUid(null)
      addLog('Đã đăng xuất')
    } catch (err) {
      addLog('Lỗi đăng xuất: ' + (err.message || err))
    }
  }

  async function savePosition(page) {
    if (!userUid || !selected) return addLog('Chưa có người dùng hoặc truyện')
    try {
      await setDoc(doc(db, `users/${userUid}/positions`, selected.id), {
        position: page,
        updatedAt: serverTimestamp()
      })
      addLog('Đã lưu vị trí trang ' + page)
    } catch (err) {
      addLog('Lưu vị trí thất bại: ' + (err.message || err))
    }
  }

  async function addBookmark(note = '') {
    if (!userUid || !selected) return addLog('Chưa có người dùng hoặc truyện')
    try {
      await setDoc(doc(db, `users/${userUid}/bookmarks`, `${selected.id}-${Date.now()}`), {
        novelId: selected.id,
        position: currentPage,
        note,
        createdAt: serverTimestamp()
      })
      addLog('Đã thêm bookmark tại trang ' + currentPage)
    } catch (err) {
      addLog('Thêm bookmark thất bại: ' + (err.message || err))
    }
  }

  function openNovel(novel) {
    setSelected(novel)
    setCurrentPage(1)
    setView('reader')
    addLog('Mở truyện: ' + (novel.title || novel.id))
  }

  function goToBookmark(bookmark) {
    setCurrentPage(bookmark.position)
    addLog('Đi đến bookmark trang ' + bookmark.position)
  }

  return (
    <div className="tablet-container">
      <div className="tablet-shell">
        <div className="app-shell">
          
          {/* ── HEADER (different for Home vs Reader) ── */}
          {view === 'home' ? (
            <header className="top-bar">
              <div className="brand">
                <div className="brand-name">NookNovel</div>
                <div className="brand-tag">Đọc truyện đồng bộ trên web và iPhone</div>
              </div>
              <div className="top-actions">
                <button onClick={refreshNovels}>Làm mới</button>
                <a className="download-button" href="/FlipHTML5 Gemini Translator.exe" download style={{ textDecoration: 'none' }}>
                  <button type="button">Download EXE</button>
                </a>
                <button className="user-icon" type="button" onClick={() => setAuthPanelOpen(true)} aria-label="Mở đăng nhập">
                  {userInfo?.photoURL
                    ? <img src={userInfo.photoURL} alt="avatar" className="user-avatar-img" />
                    : (userInfo?.displayName ? userInfo.displayName[0].toUpperCase() : '👤')
                  }
                </button>
              </div>
            </header>
          ) : (
            <header className="top-bar">
              <div className="reader-header-left">
                <button className="back-button" type="button" onClick={() => { setView('home'); setSelected(null); }} aria-label="Quay lại">
                  ‹
                </button>
                <div className="reader-title-group">
                  <div className="reader-title">{selected?.title || 'Đọc truyện'}</div>
                  <div className="reader-subtitle">{selected?.description || 'NookNovel'}</div>
                </div>
              </div>
              <div className="reader-settings">
                <button type="button" onClick={() => setTheme(theme === 'day' ? 'night' : 'day')}>
                  {theme === 'day' ? 'Chế độ đêm' : 'Chế độ ngày'}
                </button>
                <button type="button" onClick={() => setFontSize(size => Math.max(14, size - 2))}>A-</button>
                <button type="button" onClick={() => setFontSize(size => Math.min(30, size + 2))}>A+</button>
              </div>
            </header>
          )}

          {/* ── MAIN CONTENT (Home Tab System vs Reader Workspace) ── */}
          {view === 'home' ? (
            <main className="content-grid">
              
              {/* Tab 1: HOME */}
              {currentTab === 'home' && (
                <section className="tab-panel">
                  <section className="banner-row">
                    <article className="banner" id="bannerOne">
                      <div className="banner-content">
                        <div className="banner-title">Library Translator</div>
                        <div className="banner-sub">FlipHTML5 to Vietnamese reader</div>
                        <button className="pill" type="button" onClick={() => setCurrentTab('discover')}>READ NOW</button>
                      </div>
                    </article>
                    <article className="banner large" id="bannerMain">
                      <div className="banner-content">
                        <div className="banner-title" id="featuredTitle">{novels[0]?.title || 'Novel Nook'}</div>
                        <div className="banner-sub" id="featuredDesc">Tự động dịch và lưu sách ngay trên máy.</div>
                        <button className="pill" type="button" onClick={() => novels[0] && openNovel(novels[0])}>READ NOW</button>
                      </div>
                    </article>
                    <article className="banner" id="bannerThree">
                      <div className="banner-content">
                        <div className="banner-title">Gemini Automation</div>
                        <div className="banner-sub">Chạy trong nền sau khi đăng nhập</div>
                        <button className="pill" type="button" onClick={() => setCurrentTab('discover')}>READ NOW</button>
                      </div>
                    </article>
                  </section>

                  <div className="dots">...</div>

                  <section className="section-head">
                    <h2>CONTINUE READING</h2>
                    <div className="status">Đọc tiếp các bản dịch gần đây</div>
                  </section>
                  <section className="continue-row">
                    {novels.slice(0, 3).map(novel => (
                      <button key={novel.id} className="continue-card" type="button" onClick={() => openNovel(novel)}>
                        <div className="cover-fallback">📚</div>
                        <div className="continue-card-body">
                          <div className="continue-title">{novel.title || novel.id}</div>
                          <div className="continue-meta">{novel.description || 'Truyện mới'}</div>
                          <div className="mini-progress"><span style={{ width: '40%' }}></span></div>
                        </div>
                        <span className="play">&gt;</span>
                      </button>
                    ))}
                  </section>

                  <section className="section-head">
                    <h2>POPULAR NOW</h2>
                    <div className="status">GENRES&nbsp;&nbsp; Action&nbsp; Romance&nbsp; Fantasy&nbsp; Slice of Life</div>
                  </section>
                  <section className="library-line">
                    {novels.slice(0, 4).map(novel => (
                      <button key={novel.id} className="continue-card" type="button" onClick={() => openNovel(novel)}>
                        <div className="cover-fallback">📚</div>
                        <div className="continue-card-body">
                          <div className="continue-title">{novel.title || novel.id}</div>
                          <div className="continue-meta">{novel.description || 'Truyện mới'}</div>
                        </div>
                      </button>
                    ))}
                  </section>
                </section>
              )}

              {/* Tab 2: LIBRARY */}
              {currentTab === 'library' && (
                <section className="tab-panel">
                  <section className="section-head">
                    <h2>LIBRARY</h2>
                    <div className="status">Tất cả sách đã dịch trên máy này</div>
                  </section>
                  <div className="book-grid">
                    {novels.map(novel => (
                      <button key={novel.id} className="continue-card" type="button" onClick={() => openNovel(novel)}>
                        <div className="cover-fallback">📚</div>
                        <div className="continue-card-body">
                          <div className="continue-title">{novel.title || novel.id}</div>
                          <div className="continue-meta">{novel.description || 'Mở để đọc ngay'}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Tab 3: DISCOVER */}
              {currentTab === 'discover' && (
                <section className="tab-panel">
                  <div className="profile-card">
                    <h2>DISCOVER</h2>
                    <p className="helper">Xem và mở các truyện công khai trên hệ thống.</p>
                    <div className="book-grid">
                      {novels.map(novel => (
                        <button key={novel.id} className="continue-card" type="button" onClick={() => openNovel(novel)}>
                          <div className="cover-fallback">📚</div>
                          <div className="continue-card-body">
                            <div className="continue-title">{novel.title || novel.id}</div>
                            <div className="continue-meta">{novel.description || 'Xem chi tiết'}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
              )}

              {/* Tab 4: WRITE (CREATOR SPACE) */}
              {currentTab === 'creator' && (
                <section className="tab-panel">
                  <div className="profile-card">
                    <h2>CREATOR SPACE</h2>
                    <p className="helper">Tính năng đăng tác phẩm dành cho tác giả.</p>
                    <div className="control-card">
                      <div className="form-group">
                        <label>Tên tác phẩm mới</label>
                        <input type="text" placeholder="Nhập tên truyện..." />
                      </div>
                      <div className="form-group">
                        <label>Mô tả ngắn</label>
                        <textarea placeholder="Nhập mô tả tóm tắt truyện..."></textarea>
                      </div>
                      <button className="primary" type="button">TẠO TRUYỆN MỚI</button>
                    </div>
                  </div>
                </section>
              )}

              {/* Tab 5: CLOUD SYNC */}
              {currentTab === 'cloud' && (
                <section className="tab-panel">
                  <div className="profile-card">
                    <h2>CLOUD SYNC</h2>
                    <p className="helper">Bảng quản lý đồng bộ dữ liệu.</p>
                    <div className="control-card">
                      <div className="panel-row">
                        <span>Trạng thái mạng</span>
                        <strong>{online ? 'Online' : 'Ngoại tuyến'}</strong>
                      </div>
                      <div className="panel-row">
                        <span>Tài khoản</span>
                        <strong>{userInfo ? userInfo.displayName : 'Chưa đăng nhập'}</strong>
                      </div>
                      <button className="primary" type="button" onClick={refreshNovels}>LÀM MỚI DỮ LIỆU ĐỒNG BỘ</button>
                    </div>
                  </div>
                </section>
              )}

              {/* Tab 6: PROFILE */}
              {currentTab === 'profile' && (
                <section className="tab-panel">
                  <div className="profile-card">
                    <h2>PROFILE</h2>
                    <p className="helper">Hồ sơ cá nhân và cài đặt ứng dụng.</p>

                    {userUid && !userInfo?.isAnonymous ? (
                      <div className="auth-profile-panel">
                        <div className="profile-grid">
                          <label className="wide">Tên hiển thị
                            <input type="text" value={userInfo?.displayName || ''} disabled />
                          </label>
                          <label className="wide">Email tài khoản
                            <input type="text" value={userInfo?.email || ''} disabled />
                          </label>
                        </div>
                        <div style={{ marginTop: '12px', display: 'flex', gap: '10px' }}>
                          <button className="danger" type="button" style={{ flex: 1 }} onClick={signOutUser}>Đăng xuất</button>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <p className="helper">Bạn chưa đăng nhập. Nhấp vào nút bên dưới để mở giao diện đăng nhập.</p>
                        <button className="primary" type="button" onClick={() => setAuthPanelOpen(true)}>Đăng nhập ngay</button>
                      </div>
                    )}

                    <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid rgba(124,89,52,0.15)' }} />
                    <ul className="steps">
                      <li>Truyện đã lưu trong Thư viện: {novels.length}</li>
                      <li>Vị trí đọc cuối cùng: {position ?? 'Chưa có'}</li>
                    </ul>
                  </div>
                </section>
              )}
            </main>
          ) : (
            <main className="reader-panel">
              <div className="reader-workspace">
                <div className="reader-content-wrap">
                  <div className="reader-content">
                    {pages.length > 0 ? (
                      <article>
                        {pages[currentPage - 1]}
                      </article>
                    ) : (
                      <div className="empty-reader">Đang tải nội dung truyện...</div>
                    )}
                  </div>
                </div>

                <aside className="info-panel" style={{ display: 'flex', borderLeft: '1px solid rgba(124, 89, 52, .1)' }}>
                  <div className="panel-box">
                    <div className="panel-title">Bookmarks</div>
                    {bookmarks.length === 0 ? (
                      <div className="empty-list">Chưa có bookmark cho truyện này.</div>
                    ) : bookmarks.map(bookmark => (
                      <button key={bookmark.id} className="bookmark-item" onClick={() => goToBookmark(bookmark)}>
                        <span>Trang {bookmark.position}</span>
                        <small>{bookmark.note || 'Không có ghi chú'}</small>
                      </button>
                    ))}
                  </div>

                  <div className="panel-box" style={{ marginTop: 'auto' }}>
                    <div className="panel-row">
                      <span>Vị trí đã lưu</span>
                      <strong>{position ?? 'Chưa có'}</strong>
                    </div>
                  </div>
                </aside>
              </div>

              <div className="reader-footer">
                <div className="pagination">
                  <button onClick={() => setCurrentPage(page => Math.max(1, page - 1))} disabled={currentPage <= 1}>‹</button>
                  <span>Trang {currentPage} / {pages.length || 1}</span>
                  <button onClick={() => setCurrentPage(page => Math.min(page + 1, pages.length))} disabled={currentPage >= pages.length}>›</button>
                </div>
                <div className="reader-buttons">
                  <button onClick={() => savePosition(currentPage)}>Lưu vị trí</button>
                  <button onClick={() => addBookmark()}>Đánh dấu</button>
                </div>
              </div>
            </main>
          )}

          {/* ── BOTTOM TAB NAVIGATION BAR (Shown in Home View) ── */}
          {view === 'home' && (
            <nav className="bottom-nav">
              <button className={currentTab === 'home' ? 'active' : ''} type="button" onClick={() => setCurrentTab('home')}>
                <strong>H</strong><span>HOME</span>
              </button>
              <button className={currentTab === 'library' ? 'active' : ''} type="button" onClick={() => setCurrentTab('library')}>
                <strong>L</strong><span>LIBRARY</span>
              </button>
              <button className={currentTab === 'discover' ? 'active' : ''} type="button" onClick={() => setCurrentTab('discover')}>
                <strong>D</strong><span>DISCOVER</span>
              </button>
              <button className={currentTab === 'creator' ? 'active' : ''} type="button" onClick={() => setCurrentTab('creator')}>
                <strong>W</strong><span>WRITE</span>
              </button>
              <button className={currentTab === 'cloud' ? 'active' : ''} type="button" onClick={() => setCurrentTab('cloud')}>
                <strong>C</strong><span>CLOUD</span>
              </button>
              <button className={currentTab === 'profile' ? 'active' : ''} type="button" onClick={() => setCurrentTab('profile')}>
                <strong>P</strong><span>PROFILE</span>
              </button>
            </nav>
          )}

          {/* ── FOOTER STATUS BAR (Only shown when not reading) ── */}
          {view === 'home' && (
            <footer className="status-bar">
              <div>{selected ? selected.title : 'Ứng dụng đọc truyện trên web'}</div>
              <div>{online ? 'Đồng bộ tự động với Firestore' : 'Sử dụng offline, tự động đồng bộ khi online'}</div>
            </footer>
          )}

          {/* ── AUTH MODAL ── */}
          {authPanelOpen && (
            <div className="auth-modal-overlay" onClick={() => setAuthPanelOpen(false)}>
              <div className="auth-modal-card" onClick={(e) => e.stopPropagation()}>
                <button className="auth-close-x" type="button" onClick={() => setAuthPanelOpen(false)} aria-label="Đóng">
                  ✕
                </button>

                {userUid && !userInfo?.isAnonymous ? (
                  /* Profile */
                  <div className="auth-card-profile">
                    <div className="auth-card-avatar-wrap">
                      {userInfo?.photoURL
                        ? <img src={userInfo.photoURL} alt="avatar" className="auth-card-avatar-img" />
                        : <div className="auth-card-avatar-initials">{userInfo?.displayName?.[0]?.toUpperCase() || '?'}</div>
                      }
                      <span className="auth-card-online" />
                    </div>
                    <div className="auth-card-greeting">Chào mừng trở lại 👋</div>
                    <div className="auth-card-username">{userInfo?.displayName || 'Người dùng'}</div>
                    <div className="auth-card-email">{userInfo?.email}</div>
                    <div className="auth-card-badge-row">
                      <span className="auth-card-badge green">● Online</span>
                      <span className="auth-card-badge">Google Account</span>
                    </div>
                    <button
                      className="auth-card-signout"
                      type="button"
                      onClick={() => { signOutUser(); setAuthPanelOpen(false) }}
                    >
                      Đăng xuất
                    </button>
                  </div>
                ) : (
                  /* Sign In */
                  <div className="auth-card-signin">
                    <div className="auth-card-logo-wrap">
                      <div className="auth-card-logo-box">
                        <span className="auth-card-logo-emoji">📚</span>
                      </div>
                      <div className="auth-card-app-name">NookNovel</div>
                      <div className="auth-card-app-sub">Đọc truyện đồng bộ mọi nơi</div>
                    </div>
                    <div className="auth-card-tabs">
                      <button
                        type="button"
                        className={`auth-card-tab ${authTab === 'signin' ? 'active' : ''}`}
                        onClick={() => setAuthTab('signin')}
                      >Đăng nhập</button>
                      <button
                        type="button"
                        className={`auth-card-tab ${authTab === 'signup' ? 'active' : ''}`}
                        onClick={() => setAuthTab('signup')}
                      >Đăng ký</button>
                    </div>
                    <button className="auth-card-google-cta" type="button" onClick={signInGoogle}>
                      {authTab === 'signin' ? 'SIGN IN WITH GOOGLE' : 'SIGN UP WITH GOOGLE'}
                    </button>
                    <p className="auth-card-switch">
                      {authTab === 'signin'
                        ? <>Chưa có tài khoản? <button type="button" className="auth-card-link" onClick={() => setAuthTab('signup')}>Sign Up</button></>
                        : <>Đã có tài khoản? <button type="button" className="auth-card-link" onClick={() => setAuthTab('signin')}>Sign In</button></>
                      }
                    </p>
                    <p className="auth-card-legal">
                      Bằng cách tiếp tục bạn đồng ý với <span className="auth-card-legal-link">Điều khoản dịch vụ</span> của NookNovel.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
