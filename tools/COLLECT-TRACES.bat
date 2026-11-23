@echo off
title Clinic record recovery - send browser traces
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect-traces.ps1"
