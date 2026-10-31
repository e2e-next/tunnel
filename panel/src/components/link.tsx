/**
 * Catalyst's Link, wired to the panel's hash router. The panel is one page
 * served at /, so every route is a fragment: an <a href="#/rules">
 * navigates without a request, and the browser's back button still works.
 */
import * as Headless from '@headlessui/react'
import React, { forwardRef } from 'react'

export const Link = forwardRef(function Link(
  props: { href: string } & React.ComponentPropsWithoutRef<'a'>,
  ref: React.ForwardedRef<HTMLAnchorElement>
) {
  return (
    <Headless.DataInteractive>
      <a {...props} ref={ref} />
    </Headless.DataInteractive>
  )
})
