//! 启动时一起显示的窗口（像 Win11 记事本）：启动恢复的几个窗口隐藏创建，各自页面载入
//! 标签页后调 `window_ready`，凑齐了才按创建顺序一起显示、最后聚焦 `focus`；超时
//! （lib.rs `STARTUP_SHOW_TIMEOUT`）仍没凑齐就把已创建的全部显示。普通新窗口不在这里。

use std::collections::HashSet;

/// 一次启动里等着一起显示的窗口。
#[derive(Debug)]
pub struct StartupShow {
    /// 显示顺序（`Launch::windows`），去掉了没建出来 / 已销毁的窗口。
    order: Vec<String>,
    /// 最后置顶并获得焦点的窗口。
    focus: String,
    /// 页面已上报就绪的窗口。
    ready: HashSet<String>,
}

impl StartupShow {
    pub fn new(order: Vec<String>, focus: String) -> Self {
        Self {
            order,
            focus,
            ready: HashSet::new(),
        }
    }
    /// 是否全部就绪（没有窗口也算）。
    pub fn complete(&self) -> bool {
        self.order.iter().all(|label| self.ready.contains(label))
    }
    /// `label` 的页面就绪；返回这一次是否凑齐。不在批次里的窗口（普通新窗口、批次已
    /// 显示后页面重载）返回 false。
    pub fn ready(&mut self, label: &str) -> bool {
        if !self.order.iter().any(|l| l == label) || !self.ready.insert(label.to_owned()) {
            return false;
        }
        self.complete()
    }
    /// `label` 没建出来或显示前已销毁，不再等它；返回去掉它后是否凑齐（只在它确实在
    /// 批次里时才可能为 true）。
    pub fn remove(&mut self, label: &str) -> bool {
        let before = self.order.len();
        self.order.retain(|l| l != label);
        self.ready.remove(label);
        before != self.order.len() && !self.order.is_empty() && self.complete()
    }
    /// 显示顺序与要聚焦的窗口；`focus` 已不在批次里时改为最后一个窗口。
    pub fn take(self) -> (Vec<String>, String) {
        let focus = if self.order.contains(&self.focus) {
            self.focus
        } else {
            self.order.last().cloned().unwrap_or(self.focus)
        };
        (self.order, focus)
    }
}

#[cfg(test)]
mod tests {
    use super::StartupShow;

    fn batch(labels: &[&str], focus: &str) -> StartupShow {
        StartupShow::new(labels.iter().map(|l| l.to_string()).collect(), focus.into())
    }

    #[test]
    fn complete_once_every_window_is_ready() {
        let mut show = batch(&["win-1", "win-2", "win-3"], "win-2");
        assert!(!show.ready("win-3"));
        assert!(!show.ready("win-1"));
        // 重复上报（页面重载）不算凑齐。
        assert!(!show.ready("win-1"));
        assert!(show.ready("win-2"));
        assert_eq!(
            show.take(),
            (vec!["win-1".into(), "win-2".into(), "win-3".into()], "win-2".into())
        );
    }

    #[test]
    fn windows_outside_the_batch_are_ignored() {
        let mut show = batch(&["win-1"], "win-1");
        assert!(!show.ready("win-5"));
        assert!(!show.complete());
        assert!(show.ready("win-1"));
        // 凑齐后再上报的不会再凑齐一次。
        assert!(!show.ready("win-1"));
    }

    #[test]
    fn removed_windows_are_not_waited_for() {
        let mut show = batch(&["win-1", "win-2", "win-3"], "win-3");
        assert!(!show.ready("win-1"));
        assert!(!show.ready("win-2"));
        // win-3 没建出来 / 显示前销毁：其余已就绪即凑齐，焦点改为最后一个。
        assert!(show.remove("win-3"));
        assert_eq!(show.take(), (vec!["win-1".into(), "win-2".into()], "win-2".into()));
    }

    #[test]
    fn removing_unknown_or_unready_windows_does_not_complete() {
        let mut show = batch(&["win-1", "win-2"], "win-1");
        assert!(!show.remove("win-9"));
        assert!(!show.remove("win-2"));
        assert!(!show.complete());
        // 去掉的窗口再上报也不算。
        assert!(!show.ready("win-2"));
        assert!(show.ready("win-1"));
        // 全部去掉：不凑齐（没有可显示的），take 照样交出空顺序。
        let mut empty = batch(&["win-1"], "win-1");
        assert!(!empty.remove("win-1"));
        assert_eq!(empty.take(), (vec![], "win-1".into()));
    }
}
