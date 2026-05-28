"use client";

import { Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";

/**
 * Shared shell for `/todo/*` routes — rendered once by the parent route's
 * `component` so its client state (here: `sidebarOpen`) survives navigation
 * between sibling leaves.
 *
 * Do NOT include this shell inside a leaf's `renderServerComponent(...)`
 * payload. Doing so makes the shell part of the RSC tree that gets replaced
 * on every navigation, which remounts Header/Sidebar and discards their state.
 */
export function TodoShell() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  return (
    <div>
      <header>
        <button type="button" onClick={() => setSidebarOpen((v) => !v)}>
          {sidebarOpen ? "サイドバーを閉じる" : "サイドバーを開く"}
        </button>
        <nav>
          <Link to="/">← Home</Link>
        </nav>
      </header>
      <div>
        {sidebarOpen ? (
          <aside>
            <nav>
              <ul>
                <li>
                  <Link to="/todo" search={{ page: 1, limit: 20 }}>
                    一覧
                  </Link>
                </li>
                <li>
                  <Link to="/todo/about">このテンプレについて</Link>
                </li>
              </ul>
            </nav>
          </aside>
        ) : null}
        <main>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
