import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Modal, ModalContent, ModalTitle } from '@/components/ui/modal';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';

describe('UI Components', () => {
  describe('Button', () => {
    it('renders with text', () => {
      render(<Button>Click me</Button>);
      expect(screen.getByText('Click me')).toBeInTheDocument();
    });

    it('calls onClick when clicked', () => {
      const handleClick = jest.fn();
      render(<Button onClick={handleClick}>Click me</Button>);
      fireEvent.click(screen.getByText('Click me'));
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('disables when disabled prop is true', () => {
      render(<Button disabled>Click me</Button>);
      expect(screen.getByText('Click me')).toBeDisabled();
    });

    it('renders with different variants', () => {
      const { rerender } = render(<Button variant="default">Default</Button>);
      expect(screen.getByText('Default')).toBeInTheDocument();
      
      rerender(<Button variant="destructive">Destructive</Button>);
      expect(screen.getByText('Destructive')).toBeInTheDocument();
      
      rerender(<Button variant="outline">Outline</Button>);
      expect(screen.getByText('Outline')).toBeInTheDocument();
    });
  });

  describe('Input', () => {
    it('renders with placeholder', () => {
      render(<Input placeholder="Enter text" />);
      expect(screen.getByPlaceholderText('Enter text')).toBeInTheDocument();
    });

    it('handles value changes', () => {
      const handleChange = jest.fn();
      render(<Input onChange={handleChange} />);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'test' } });
      expect(handleChange).toHaveBeenCalled();
    });

    it('disables when disabled prop is true', () => {
      render(<Input disabled />);
      expect(screen.getByRole('textbox')).toBeDisabled();
    });
  });

  describe('Card', () => {
    it('renders card structure', () => {
      render(
        <Card>
          <CardHeader>
            <CardTitle>Test Title</CardTitle>
          </CardHeader>
          <CardContent>
            <p>Test content</p>
          </CardContent>
        </Card>
      );
      expect(screen.getByText('Test Title')).toBeInTheDocument();
      expect(screen.getByText('Test content')).toBeInTheDocument();
    });
  });

  describe('Badge', () => {
    it('renders with default variant', () => {
      render(<Badge>Default</Badge>);
      expect(screen.getByText('Default')).toBeInTheDocument();
    });

    it('renders with different variants', () => {
      const { rerender } = render(<Badge variant="success">Success</Badge>);
      expect(screen.getByText('Success')).toBeInTheDocument();
      
      rerender(<Badge variant="destructive">Error</Badge>);
      expect(screen.getByText('Error')).toBeInTheDocument();
      
      rerender(<Badge variant="warning">Warning</Badge>);
      expect(screen.getByText('Warning')).toBeInTheDocument();
    });
  });

  describe('Modal', () => {
    it('renders content when open', () => {
      render(
        <Modal open onOpenChange={() => {}}>
          <ModalContent>
            <ModalTitle>Confirm</ModalTitle>
            <p>Modal content</p>
          </ModalContent>
        </Modal>
      );
      expect(screen.getByText('Modal content')).toBeInTheDocument();
    });

    it('does not render content when closed', () => {
      render(
        <Modal open={false} onOpenChange={() => {}}>
          <ModalContent>
            <ModalTitle>Confirm</ModalTitle>
            <p>Modal content</p>
          </ModalContent>
        </Modal>
      );
      expect(screen.queryByText('Modal content')).not.toBeInTheDocument();
    });
  });

  describe('Skeleton', () => {
    it('renders with default dimensions', () => {
      const { container } = render(<Skeleton />);
      expect(container.firstChild).toHaveClass('animate-pulse');
    });

    it('renders with custom dimensions', () => {
      const { container } = render(<Skeleton className="h-10 w-20" />);
      expect(container.firstChild).toHaveClass('h-10', 'w-20');
    });
  });

  describe('Label', () => {
    it('renders label text', () => {
      render(<Label>Test Label</Label>);
      expect(screen.getByText('Test Label')).toBeInTheDocument();
    });
  });
});

describe('Accessibility', () => {
  it('buttons have accessible names', () => {
    render(<Button>Submit</Button>);
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
  });

  it('inputs have associated labels', () => {
    render(
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" />
      </div>
    );
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });
});
