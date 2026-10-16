@echo off
REM ============================================================
REM  Pre-install a skill's venv with its dependencies (plan A + C).
REM
REM  Why this exists:
REM  - The app's bundled Python is bare stdlib only; skills that need
REM    third-party packages install them into their OWN venv inside the
REM    skill directory (per-skill isolation).
REM  - run_skill_script has a hard 30s budget, so a network install of
REM    PyMuPDF/numpy/pdfplumber/... can never finish inside the app.
REM    Pre-installing the venv on the dev machine (no timeout here)
REM    makes the skill work out of the box.
REM
REM  Plan C (mirror): PIP_INDEX_URL points at the Tencent PyPI mirror.
REM    The app also injects this variable into skill script envs, so
REM    on-demand installs use the same mirror.
REM
REM  Idempotent: existing venv is reused; pip skips satisfied
REM  requirements without touching the network, so re-running is cheap.
REM
REM  To pre-install a DIFFERENT skill, edit SKILL_SCRIPTS below.
REM  Run: double-click, or from a terminal:
REM      cmd /c scripts\setup-skill-venv.bat
REM ============================================================
setlocal EnableDelayedExpansion

REM --- 1. Locate the app's bundled Python (same build the app ships) ---
REM %%~fI normalizes away the ".." segment: PATH entries containing ".."
REM are unreliable for the "where python" lookup done inside setup.bat.
set "APP_ROOT=%~dp0.."
for %%I in ("%APP_ROOT%") do set "APP_ROOT=%%~fI"
set "APP_PY_DIR=%APP_ROOT%\resources\runtime\python"
set "APP_PY=%APP_PY_DIR%\python.exe"
if not exist "%APP_PY%" (
    echo [WARN] bundled Python not found: %APP_PY%
    echo        ^(run "npm run fetch-runtime" in mini-agent, or fall back below^)
    where py >nul 2>nul
    if !errorlevel! EQU 0 (
        set "APP_PY=py -3"
    ) else (
        where python >nul 2>nul
        if !errorlevel! EQU 0 (set "APP_PY=python") else (
            echo [ERROR] no Python found ^(bundled / py launcher / python^).
            exit /b 1
        )
    )
) else (
    REM Inject the bundled Python into PATH so the skill's setup.bat
    REM detects it via "where python". Without this, setup.bat falls
    REM through to downloading Python from GitHub (slow / blocked here)
    REM even when a ready venv already exists.
    set "PATH=%APP_PY_DIR%;%PATH%"
)

REM --- 2. Target skill scripts dir ---
set "SKILL_SCRIPTS=E:\code\LocalAgent\skills\document-skills\pdfkit-py\scripts"
if not exist "%SKILL_SCRIPTS%\pdfkit.py" (
    echo [ERROR] skill entry not found: %SKILL_SCRIPTS%\pdfkit.py
    exit /b 1
)

REM --- 3. Mirror config (plan C) ---
set "PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple"
set "PIP_DISABLE_PIP_VERSION_CHECK=1"

echo === pre-installing skill venv ===
echo   python : %APP_PY%
echo   skill  : %SKILL_SCRIPTS%
echo   mirror : %PIP_INDEX_URL%
echo   note   : first install downloads ~100MB of wheels, please wait
echo.

REM --- 4. Create venv if absent (setup.bat reuses it and skips creation) ---
if not exist "%SKILL_SCRIPTS%\venv\Scripts\python.exe" (
    echo [1/2] creating venv...
    %APP_PY% -m venv "%SKILL_SCRIPTS%\venv"
    if not exist "%SKILL_SCRIPTS%\venv\Scripts\python.exe" (
        echo [ERROR] venv creation failed.
        echo         If ensurepip is missing, try: %APP_PY% -m ensurepip --upgrade
        exit /b 1
    )
    echo [OK] venv created
) else (
    echo [1/2] venv already exists, reusing
)

REM --- 5. Run the skill's own setup.bat ---
REM It installs requirements.txt (through our mirror env), downloads the
REM bundled font from Tencent CDN, runs its smoke test, and removes the
REM setup section from SKILL.md. No 30s limit applies here (manual run).
echo [2/2] running setup.bat ^(pip install over mirror, may take minutes^)...
call "%SKILL_SCRIPTS%\setup.bat"
if errorlevel 1 (
    echo.
    echo [ERROR] setup.bat failed - see the output above.
    echo         Common causes: mirror unreachable, or a package without a
    echo         wheel for this Python version. Fix and re-run this script.
    exit /b 1
)

echo.
echo === done: skill venv is ready ===
echo The app can now run this skill's .py entry directly.
echo Re-test in the app: upload the PDF and ask for the summary again.
