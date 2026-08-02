from pathlib import Path

original = Path(__file__).with_name('apply_pr53_audit_fixes.py')
source = original.read_text(encoding='utf-8')
start = source.index("write('.github/workflows/e2ee-ci.yml'")
end = source.index("\n\nPath(__file__).unlink()", start)
source = source[:start] + source[end:]
source = source.replace(
    "Path(__file__).unlink()",
    "original_path = Path(__file__); original_path.unlink(); original_path.with_name('apply_pr53_audit_fixes_v2.py').unlink()",
)
exec(compile(source, str(original), 'exec'), {'__file__': str(original), '__name__': '__main__'})
