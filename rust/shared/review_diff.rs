use serde_json::{Value, json};

pub fn line_diff(before: &str, after: &str) -> Value {
    if before.encode_utf16().count() + after.encode_utf16().count() > 400_000 {
        return large();
    }
    let split = |value: &str| value.is_empty();
    let a: Vec<_> = if split(before) {
        Vec::new()
    } else {
        before.split('\n').collect()
    };
    let b: Vec<_> = if split(after) {
        Vec::new()
    } else {
        after.split('\n').collect()
    };
    if a.len() > 20_000 || b.len() > 20_000 {
        return large();
    }
    let prefix = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let x = &a[prefix..a.len() - suffix];
    let y = &b[prefix..b.len() - suffix];
    let mut ops = a[..prefix]
        .iter()
        .map(|line| ("context", *line))
        .collect::<Vec<_>>();
    let approximate = x.len() * y.len() > 1_000_000;
    if approximate {
        ops.extend(x.iter().map(|line| ("delete", *line)));
        ops.extend(y.iter().map(|line| ("add", *line)));
    } else {
        let width = y.len() + 1;
        let mut grid = vec![0_u32; (x.len() + 1) * width];
        for i in (0..x.len()).rev() {
            for j in (0..y.len()).rev() {
                grid[i * width + j] = if x[i] == y[j] {
                    1 + grid[(i + 1) * width + j + 1]
                } else {
                    grid[(i + 1) * width + j].max(grid[i * width + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < x.len() || j < y.len() {
            if i < x.len() && j < y.len() && x[i] == y[j] {
                ops.push(("context", x[i]));
                i += 1;
                j += 1;
            } else if i < x.len()
                && (j == y.len() || grid[(i + 1) * width + j] >= grid[i * width + j + 1])
            {
                ops.push(("delete", x[i]));
                i += 1;
            } else {
                ops.push(("add", y[j]));
                j += 1;
            }
        }
    }
    ops.extend(a[a.len() - suffix..].iter().map(|line| ("context", *line)));
    let mut visible = vec![false; ops.len()];
    let (mut added, mut removed) = (0, 0);
    for (index, (kind, _)) in ops.iter().enumerate() {
        if *kind == "context" {
            continue;
        }
        if *kind == "add" {
            added += 1;
        } else {
            removed += 1;
        }
        let end = (index + 4).min(ops.len());
        visible[index.saturating_sub(3)..end].fill(true);
    }
    let unchanged = added == 0 && removed == 0;
    if unchanged {
        let end = ops.len().min(120);
        visible[..end].fill(true);
    }
    let (mut old, mut new, mut last, mut included) = (0, 0, 0, 0);
    let mut rows = Vec::new();
    for (index, (kind, text)) in ops.iter().enumerate() {
        let old_line = (*kind != "add").then(|| {
            old += 1;
            old
        });
        let new_line = (*kind != "delete").then(|| {
            new += 1;
            new
        });
        if !visible[index] {
            continue;
        }
        if rows.len() + if index > last { 2 } else { 1 } > 2000 {
            break;
        }
        if index > last {
            rows.push(json!({"type":"gap","text":format!("{} unchanged lines",index-last)}));
        }
        rows.push(json!({"type":kind,"text":text,"oldLine":old_line,"newLine":new_line}));
        last = index + 1;
        included += 1;
    }
    json!({"rows":rows,"added":added,"removed":removed,"approximate":approximate,
        "truncated":included<visible.iter().filter(|visible|**visible).count()||unchanged&&ops.len()>120})
}

fn large() -> Value {
    json!({"rows":[],"added":null,"removed":null,"truncated":true,"approximate":true,
        "reason":"This file is too large for an inline comparison. Use the file preview or a local snapshot."})
}
