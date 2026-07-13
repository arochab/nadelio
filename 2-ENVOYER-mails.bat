@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ============================================================
echo   ENVOI REEL des 4 mails aux agences.
echo   Ils partiront de adam@nadelio.com avec le guide en piece jointe.
echo ============================================================
echo.
set /p CONF=Tape OUI puis Entree pour envoyer, ou ferme la fenetre pour annuler :
if /I not "%CONF%"=="OUI" (
  echo.
  echo Annule. Rien n'a ete envoye.
  echo.
  pause
  exit /b
)
echo.
python tools\send-batch.py --send
echo.
echo ============================================================
echo   Termine. Regarde ci-dessus si les 4 sont partis.
echo   Les reponses arriveront sur ta Gmail.
echo ============================================================
echo.
pause
