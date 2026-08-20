# LITUM3D

**Production full-stack e-commerce platform for personalised 3D lithophanes.**

**Live:** https://litum3d.com

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-000000?style=flat&logo=express&logoColor=white)](https://expressjs.com/)
[![MySQL](https://img.shields.io/badge/MySQL-4479A1?style=flat&logo=mysql&logoColor=white)](https://www.mysql.com/)
[![Stripe](https://img.shields.io/badge/Stripe-635BFF?style=flat&logo=stripe&logoColor=white)](https://stripe.com/)
[![Nginx](https://img.shields.io/badge/Nginx-009639?style=flat&logo=nginx&logoColor=white)](https://nginx.org/)
[![Production](https://img.shields.io/badge/Status-Production-brightgreen?style=flat)]()

## Overview

LITUM3D is a real, production e-commerce platform built for a physical business that designs and 3D-prints personalised lithophane products. It is not an academic exercise — it is a live store that handles real customers, real orders and real payments.

## Core Features

- Dynamic product catalogue with variants/options, including products with and without variants
- Photo personalisation workflow
- Cart and checkout
- Server-side pricing
- Stripe payments
- Order persistence and Admin workflows
- Order status management
- Transactional emails
- Customer support reply flow
- Multilingual storefront (ES / DE / FR)
- Transactional email locale support (ES / DE / FR / EN)
- Private upload handling

## Architecture

High-level request flow:

Browser → Nginx / TLS → Express / Node.js → MySQL

External / auxiliary services: Stripe, SMTP, private media/upload handling.

No internal URLs, credentials or infrastructure details are published here.

## Production & Security

- Nginx reverse proxy
- PM2 process management
- Linux VPS
- Secure sessions
- Rate limiting
- CSRF protections where applicable
- Restricted, private upload handling
- HTTP security headers
- CSP (Report-Only)
- www → canonical apex redirect

## Testing

41 automated verification scripts currently pass as part of the launch baseline. They cover, among other areas: pricing, checkout, payments, Stripe webhook handling, uploads privacy, sessions, CSRF, rate limiting, Admin authentication, internationalisation, SEO, security headers, transactional email, and legal/content consistency.

## Tech Stack

Node.js · Express · MySQL · JavaScript · Stripe · Nodemailer · Nginx · PM2 · Linux VPS

## Status

Production / live.

## Author

**Rubén Fernández**
[GitHub profile](https://github.com/rubenfernandez-dev) · [litum3d.com](https://litum3d.com)
